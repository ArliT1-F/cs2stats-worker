import { decompress } from "fzstd";
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createClient } from "@supabase/supabase-js";
import { parseEvent } from "@laihoe/demoparser2";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POLL_MS = Number(process.env.POLL_MS || 30000);
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseMaybeJson(value) {
  if (typeof value === "string") return JSON.parse(value);
  return value;
}

async function decompressIfNeeded(inputPath) {
  if (!inputPath.endsWith(".zst")) {
    return inputPath;
  }
  const outputPath = inputPath.replace(/\.zst$/, "");
  const compressed = await fs.readFile(inputPath);
  const decompressed = decompress(compressed);
  await fs.writeFile(outputPath, decompressed);
  await fs.rm(inputPath, { force: true });
  return outputPath;
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download demo: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outputPath, buffer);
}
function normalizeCoordinate(value) {
  // Temporary placeholder.
  // Real map conversion comes later.
  // This keeps coordinates inside the 2D viewer area.
  const n = Number(value || 0);
  return Math.max(5, Math.min(95, 50 + n / 50));
}
function convertPlayerDeathEventsToViewerFormat(events, matchRow) {
  const playersBySteamId = new Map();
  const kills = events.map((event, index) => {
    const victimSteamId = String(
      event.player_steamid ||
      event.user_steamid ||
      event.steamid ||
      `victim-${index}`
    );
    const attackerSteamId = String(
      event.attacker_steamid ||
      event.attacker ||
      `attacker-${index}`
    );
    const victimName =
      event.player_name ||
      event.user_name ||
      `Victim ${index + 1}`;
    const attackerName =
      event.attacker_name ||
      `Attacker ${index + 1}`;
    if (!playersBySteamId.has(victimSteamId)) {
      playersBySteamId.set(victimSteamId, {
        steamId: victimSteamId,
        name: victimName,
        team: "CT",
        color: "#38bdf8"
      });
    }
    if (!playersBySteamId.has(attackerSteamId)) {
      playersBySteamId.set(attackerSteamId, {
        steamId: attackerSteamId,
        name: attackerName,
        team: "T",
        color: "#f59e0b"
      });
    }
    const victimState = {
      steamId: victimSteamId,
      x: normalizeCoordinate(event.X),
      y: normalizeCoordinate(event.Y),
      yawDeg: Number(event.yaw || 0),
      hp: 0,
      armor: Number(event.armor_value || 0),
      weapon: String(event.active_weapon_name || "Unknown"),
      alive: false
    };
    const attackerState = {
      steamId: attackerSteamId,
      x: normalizeCoordinate(Number(event.X || 0) - 400),
      y: normalizeCoordinate(Number(event.Y || 0) - 200),
      yawDeg: Number(event.yaw || 0),
      hp: 100,
      armor: 100,
      weapon: String(event.weapon || event.active_weapon_name || "Unknown"),
      alive: true
    };
    return {
      id: `${matchRow.id}-kill-${index + 1}`,
      round: Number(event.total_rounds_played || 1) + 1,
      tick: Number(event.tick || event.game_time || index),
      timeSeconds: Math.floor(Number(event.tick || index * 64) / 64),
      attackerSteamId,
      victimSteamId,
      assisterSteamId: event.assister_steamid ? String(event.assister_steamid) : null,
      weapon: String(event.weapon || event.active_weapon_name || "Unknown"),
      headshot: Boolean(event.headshot),
      throughSmoke: Boolean(event.through_smoke),
      wallbang: Boolean(event.penetrated || event.wallbang),
      blind: Boolean(event.attacker_blind),
      attacker: attackerState,
      victim: victimState,
      snapshot: [attackerState, victimState]
    };
  });
  return {
    id: matchRow.id,
    source: matchRow.source || "faceit",
    map: {
      name: matchRow.map_name || "unknown",
      displayName: matchRow.map_name || "Unknown",
      coordinateMode: "normalized"
    },
    tickRate: 64,
    durationSeconds: kills.length ? Math.max(...kills.map((k) => k.timeSeconds)) : 0,
    score: {
      t: 0,
      ct: 0
    },
    players: Array.from(playersBySteamId.values()),
    kills
  };
}
async function processMatch(matchRow) {
  console.log(`Processing ${matchRow.id}`);
  if (!matchRow.raw_demo_url) {
    throw new Error("Match row has no raw_demo_url");
  }
  const compressed = matchRow.raw_demo_url.endsWith(".zst");
  const downloadPath = path.join(
    os.tmpdir(),
    compressed ? `${matchRow.id}.dem.zst` : `${matchRow.id}.dem`
  );
  await supabase
    .from("demo_matches")
    .update({ status: "downloading", error: null })
    .eq("id", matchRow.id);
  await downloadFile(matchRow.raw_demo_url, downloadPath);
  const demoPath = await decompressIfNeeded(downloadPath);
  await supabase
    .from("demo_matches")
    .update({ status: "parsing" })
    .eq("id", matchRow.id);
  const rawEvents = parseMaybeJson(
    parseEvent(
      demoPath,
      "player_death",
      [
        "X",
        "Y",
        "yaw",
        "health",
        "armor_value",
        "active_weapon_name",
        "player_name",
        "player_steamid",
        "team_num"
      ],
      ["total_rounds_played"]
    )
  );
  const parsedJson = convertPlayerDeathEventsToViewerFormat(rawEvents, matchRow);
  await supabase
    .from("demo_matches")
    .update({
      status: "parsed",
      parsed_json: parsedJson,
      parsed_at: new Date().toISOString(),
      error: null
    })
    .eq("id", matchRow.id);
  await fs.rm(demoPath, { force: true });
  console.log(`Finished ${matchRow.id}`);
}
async function pollOnce() {
  const { data, error } = await supabase
    .from("demo_matches")
    .select("*")
    .eq("status", "queued")
    .not("raw_demo_url", "is", null)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) {
    throw error;
  }
  const matchRow = data?.[0];
  if (!matchRow) {
    console.log("No queued demos");
    return;
  }
  try {
    await processMatch(matchRow);
  } catch (error) {
    console.error(error);
    await supabase
      .from("demo_matches")
      .update({
        status: "failed",
        error: String(error?.message || error)
      })
      .eq("id", matchRow.id);
  }
}
async function main() {
  console.log("CS2 demo worker started");
  while (true) {
    await pollOnce();
    await sleep(POLL_MS);
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});