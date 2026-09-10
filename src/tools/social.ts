import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { api, day, json, SteamError, SUMMARY_BATCH } from "../steam";
import type { ToolContext } from "./context";

export function registerSocialTools(server: McpServer, { cfg }: ToolContext) {
  server.registerTool(
    "profile_status",
    {
      title: "Profile status",
      description: "Account status: online state, current game, Steam level and ban flags.",
      inputSchema: z.object({}),
    },
    async () => {
      const [summary, level, bans] = await Promise.all([
        api<{
          response: {
            players: Array<{
              personaname: string;
              personastate: number;
              gameextrainfo?: string;
              lastlogoff?: number;
              timecreated?: number;
            }>;
          };
        }>(cfg, "ISteamUser/GetPlayerSummaries/v2/", { steamids: cfg.steamId }),
        api<{ response: { player_level?: number } }>(cfg, "IPlayerService/GetSteamLevel/v1/", {
          steamid: cfg.steamId,
        }).catch(() => null),
        api<{
          players: Array<{ VACBanned: boolean; NumberOfGameBans: number }>;
        }>(cfg, "ISteamUser/GetPlayerBans/v1/", { steamids: cfg.steamId }).catch(() => null),
      ]);

      const p = summary.response.players[0];
      const states = ["offline", "online", "busy", "away", "snooze", "looking to trade", "looking to play"];

      return json({
        name: p?.personaname ?? null,
        // An unresolvable SteamID comes back as an empty players array. Saying
        // "offline" there would be a confident wrong answer.
        state: p ? (states[p.personastate] ?? "unknown") : "unknown",
        playing_now: p?.gameextrainfo ?? null,
        last_logoff: day(p?.lastlogoff),
        account_created: day(p?.timecreated),
        steam_level: level?.response.player_level ?? null,
        vac_banned: bans?.players[0]?.VACBanned ?? null,
        game_bans: bans?.players[0]?.NumberOfGameBans ?? null,
      });
    },
  );

  server.registerTool(
    "friends",
    {
      title: "Friends",
      description:
        "Friends list with online status and what they are playing. Requires the friends list to be public.",
      inputSchema: z.object({
        online_only: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(25),
      }),
    },
    async ({ online_only, limit }) => {
      const list = await api<{
        friendslist?: { friends?: Array<{ steamid: string; friend_since: number }> };
      }>(cfg, "ISteamUser/GetFriendList/v1/", {
        steamid: cfg.steamId,
        relationship: "friend",
      }).catch((error: unknown) => {
        // A non-public friends list answers 401. The API key is not the problem,
        // so don't repeat the generic key-or-privacy message here.
        if (error instanceof SteamError && error.status === 401) return null;
        throw error;
      });

      if (!list) {
        return json({
          count: 0,
          friends: [],
          note: "Steam would not serve this friends list — its privacy setting is not public.",
        });
      }

      const all = list.friendslist?.friends ?? [];
      if (!all.length) return json({ count: 0, total_friends: 0, friends: [] });

      // Ask about everyone Steam will answer for in one call, and slice only
      // AFTER filtering: slicing first reports the online share of an arbitrary
      // first page as though it were the online share of the whole list.
      const ids = all.slice(0, SUMMARY_BATCH).map((f) => f.steamid);
      const summaries = await api<{
        response: {
          players: Array<{
            steamid: string;
            personaname: string;
            personastate: number;
            gameextrainfo?: string;
          }>;
        };
      }>(cfg, "ISteamUser/GetPlayerSummaries/v2/", { steamids: ids.join(",") });

      const players = summaries.response.players
        .filter((p) => !online_only || p.personastate !== 0)
        .map((p) => ({
          name: p.personaname,
          online: p.personastate !== 0,
          playing: p.gameextrainfo ?? null,
        }));

      return json({
        count: players.length,
        total_friends: all.length,
        friends: players.slice(0, limit),
        note:
          all.length > SUMMARY_BATCH
            ? `Checked the first ${SUMMARY_BATCH} of ${all.length} friends; Steam serves at most that many per call.`
            : undefined,
      });
    },
  );
}
