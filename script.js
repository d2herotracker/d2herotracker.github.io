/* =========================================================================
 * Destiny 2 Loadout Tracker
 * =========================================================================
 * Bungie.net Platform API endpoints used (full docs at
 * https://bungie-net.github.io/multi/index.html):
 *
 *  - GET  /Destiny2/Manifest/
 *      Returns download paths for the current game-content "Manifest",
 *      including per-table JSON files (jsonWorldComponentContentPaths).
 *
 *  - POST /Destiny2/SearchDestinyPlayerByBungieName/{membershipType}/
 *      Resolves a "Name#1234" Bungie Name to a membershipId +
 *      membershipType we can use for profile calls.
 *
 *  - GET  /Destiny2/{membershipType}/Profile/{membershipId}/
 *      ?components=200,205,305
 *      Returns character + equipment + socket data. Component IDs:
 *        200 = Characters          (per-character basic info)
 *        205 = CharacterEquipment  (itemHash/instanceId per equipped item)
 *        305 = ItemSockets         (plugged sockets, incl. subclass plugs)
 *
 *  - GET  /Destiny2/{membershipType}/Account/{membershipId}/Character/
 *      {characterId}/Stats/Activities/?count=1&mode=0&page=0
 *      Per-character activity history, used by "Auto-detect Teammates" to
 *      find a player's most recent completed/reported activity.
 *
 *  - GET  /Destiny2/Stats/PostGameCarnageReport/{instanceId}/
 *      Full report for one activity instance, including an "entries" array
 *      listing every player who was in it - that's how teammates are found.
 *
 * All requests require an X-API-Key header from a Bungie application:
 * https://www.bungie.net/en/Application
 *
 * NOTE on "Auto-detect Teammates": this reflects who was in the seed
 * player's last *completed/reported* activity (a PGCR), not their live
 * fireteam right now - Bungie's API has no "who's in my party" endpoint.
 * ========================================================================= */

// ===================== CONFIG (edit this section) =======================

const BUNGIE_API_KEY = "PASTE_MY_KEY_HERE";

// One entry per player you want to track. Bungie Name format is
// "DisplayName#1234" (the number is the "code" shown on their profile).
const ROSTER = [
  { displayName: "Guardian#0001" },
  { displayName: "Guardian#0002" },
];

const POLL_INTERVAL_MS = 45 * 1000;

// ===================== CONSTANTS =========================================

const API_ROOT = "https://www.bungie.net/Platform";
const ICON_ROOT = "https://www.bungie.net";

// Inventory bucket hashes, used to sort equipped items into slots.
const WEAPON_BUCKETS = {
  1498876634: "Kinetic",
  2465295065: "Energy",
  953998645: "Power",
};
const ARMOR_BUCKETS = {
  3448274439: "Helmet",
  3551918588: "Arms",
  14239492: "Chest",
  20886954: "Legs",
  1585787867: "Class",
};
const SUBCLASS_BUCKET = 3284755031;

const CLASS_NAMES = { 0: "Titan", 1: "Hunter", 2: "Warlock" };

// localStorage keys (small data only - big manifest tables go in IndexedDB).
const LS_MANIFEST_VERSION = "d2tracker.manifestVersion";
const LS_MEMBERSHIP_PREFIX = "d2tracker.membership."; // + displayName
const LS_SEED_NAME = "d2tracker.seedName"; // last name used to find teammates

// Manifest tables we cache: items (for names/icons) and activities (for the
// "Found teammates from <activity name>" status message).
const MANIFEST_TABLES = ["DestinyInventoryItemDefinition", "DestinyActivityDefinition"];

// ===================== STATE =============================================

// Loaded at startup: tableName -> { hash (number): definition }. Starts as
// empty tables so lookups are safe even before ensureManifestLoaded() finishes.
let manifestTables = { DestinyInventoryItemDefinition: {}, DestinyActivityDefinition: {} };

// In-memory "last seen" loadout, used only to detect changes between polls.
// Shape: lastLoadouts[displayName][characterId] = loadoutObject (see below).
// Intentionally not persisted - a page refresh just starts a fresh baseline.
const lastLoadouts = {};

// ===================== SMALL DOM HELPERS =================================

function $(selector) {
  return document.querySelector(selector);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// ===================== BUNGIE API HELPERS ================================

// Wraps fetch() with the API key header and Bungie's envelope error format.
// Bungie always returns HTTP 200 with an ErrorCode; 1 means success.
async function bungieFetch(path, options = {}) {
  const response = await fetch(API_ROOT + path, {
    ...options,
    headers: { "X-API-Key": BUNGIE_API_KEY, ...options.headers },
  });

  if (response.status === 429) {
    throw new Error("Rate limited by Bungie API - will retry next poll");
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} calling ${path}`);
  }

  const body = await response.json();
  if (body.ErrorCode !== 1) {
    throw new Error(body.Message || body.ErrorStatus || "Unknown Bungie API error");
  }
  return body.Response;
}

// ===================== MANIFEST CACHE (IndexedDB) ========================
// The item definition table is tens of MB - too big for localStorage - so
// it's cached in IndexedDB and only re-downloaded when the version changes.

function openManifestDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("d2tracker", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("tables");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet(db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tables", "readonly").objectStore("tables").get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbSet(db, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("tables", "readwrite").objectStore("tables").put(value, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Loads each table in MANIFEST_TABLES into memory, using cached copies
// unless the manifest version on Bungie's servers has changed.
async function ensureManifestLoaded() {
  const manifest = await bungieFetch("/Destiny2/Manifest/");
  const currentVersion = manifest.version;
  const versionMatches = currentVersion === localStorage.getItem(LS_MANIFEST_VERSION);

  const db = await openManifestDb();

  for (const tableName of MANIFEST_TABLES) {
    if (versionMatches) {
      const cached = await idbGet(db, tableName);
      if (cached) {
        manifestTables[tableName] = cached;
        continue;
      }
    }

    // Version changed (or first run) - download the fresh table and cache it.
    const tablePath = manifest.jsonWorldComponentContentPaths.en[tableName];
    const tableResponse = await fetch(ICON_ROOT + tablePath);
    manifestTables[tableName] = await tableResponse.json();
    await idbSet(db, tableName, manifestTables[tableName]);
  }

  localStorage.setItem(LS_MANIFEST_VERSION, currentVersion);
}

function getItemDef(hash) {
  return manifestTables.DestinyInventoryItemDefinition[hash] || null;
}

// Used for the "Found teammates from last activity: <name>" status message.
function getActivityName(activityHash) {
  const def = manifestTables.DestinyActivityDefinition[activityHash];
  return def && def.displayProperties ? def.displayProperties.name : "an unknown activity";
}

function iconUrl(def) {
  if (!def || !def.displayProperties || !def.displayProperties.icon) return "";
  return ICON_ROOT + def.displayProperties.icon;
}

function itemName(hash) {
  const def = getItemDef(hash);
  return def && def.displayProperties ? def.displayProperties.name : `Unknown (${hash})`;
}

// ===================== MEMBERSHIP RESOLUTION =============================

// Looks up membershipId/membershipType for a "Name#1234" Bungie Name,
// caching the result in localStorage so we don't repeat this every poll.
async function resolveMembership(displayName) {
  const cacheKey = LS_MEMBERSHIP_PREFIX + displayName;
  const cached = localStorage.getItem(cacheKey);
  if (cached) return JSON.parse(cached);

  const [name, code] = displayName.split("#");
  const results = await bungieFetch("/Destiny2/SearchDestinyPlayerByBungieName/-1/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: name, displayNameCode: Number(code) }),
  });

  if (!results.length) {
    throw new Error(`No player found for "${displayName}"`);
  }

  // Prefer the cross-save "primary" platform membership if one is set,
  // otherwise fall back to whatever the search returned first.
  const primary = results.find((r) => r.crossSaveOverride === r.membershipType) || results[0];

  const membership = {
    membershipId: primary.membershipId,
    membershipType: primary.membershipType,
  };
  localStorage.setItem(cacheKey, JSON.stringify(membership));
  return membership;
}

// ===================== PROFILE / LOADOUT BUILDING =========================

async function fetchProfile(membership) {
  const path = `/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=200,205,305`;
  return bungieFetch(path);
}

// Turns raw profile components into a simple per-character loadout object:
// { className, weapons: {slot: itemHash}, armor: {slot: itemHash},
//   subclassHash, aspects: [hash...], fragments: [hash...] }
function buildLoadout(profile, characterId) {
  const character = profile.characters.data[characterId];
  const equipment = profile.characterEquipment.data[characterId].items;
  const sockets = profile.itemComponents.sockets.data;

  const loadout = {
    className: CLASS_NAMES[character.classType] || "Unknown",
    weapons: {},
    armor: {},
    subclassHash: null,
    aspects: [],
    fragments: [],
  };

  for (const item of equipment) {
    if (WEAPON_BUCKETS[item.bucketHash]) {
      loadout.weapons[WEAPON_BUCKETS[item.bucketHash]] = item.itemHash;
    } else if (ARMOR_BUCKETS[item.bucketHash]) {
      loadout.armor[ARMOR_BUCKETS[item.bucketHash]] = item.itemHash;
    } else if (item.bucketHash === SUBCLASS_BUCKET) {
      loadout.subclassHash = item.itemHash;
      const socketData = sockets[item.itemInstanceId];
      if (socketData) {
        for (const socket of socketData.sockets) {
          classifyPlug(socket.plugHash, loadout);
        }
      }
    }
  }

  return loadout;
}

// Sorts a plugged socket into the aspects/fragments list, skipping empty
// slots and anything that isn't actually an Aspect or Fragment plug.
function classifyPlug(plugHash, loadout) {
  const def = getItemDef(plugHash);
  if (!def || !def.displayProperties || !def.displayProperties.name) return;
  const name = def.displayProperties.name;
  if (name.startsWith("Empty")) return;

  if (def.itemTypeDisplayName === "Aspect") loadout.aspects.push(plugHash);
  else if (def.itemTypeDisplayName === "Fragment") loadout.fragments.push(plugHash);
}

// ===================== DIFF DETECTION =====================================

// Compares two loadouts for the same character and returns human-readable
// change strings, e.g. "Guardian equipped Ace of Spades (Kinetic)".
function diffLoadouts(displayName, prev, curr) {
  if (!prev) return []; // First time we've seen this character - no diff yet.
  const changes = [];

  for (const slot of Object.keys(curr.weapons)) {
    if (curr.weapons[slot] !== prev.weapons[slot]) {
      changes.push(`${displayName} equipped ${itemName(curr.weapons[slot])} (${slot})`);
    }
  }
  for (const slot of Object.keys(curr.armor)) {
    if (curr.armor[slot] !== prev.armor[slot]) {
      changes.push(`${displayName} equipped ${itemName(curr.armor[slot])} (${slot} armor)`);
    }
  }
  if (curr.subclassHash !== prev.subclassHash) {
    changes.push(`${displayName} switched subclass to ${itemName(curr.subclassHash)}`);
  }

  for (const hash of curr.aspects) {
    if (!prev.aspects.includes(hash)) changes.push(`${displayName} equipped aspect ${itemName(hash)}`);
  }
  for (const hash of curr.fragments) {
    if (!prev.fragments.includes(hash)) changes.push(`${displayName} equipped fragment ${itemName(hash)}`);
  }

  return changes;
}

function pushChanges(changes) {
  const feed = $("#changes-feed");
  for (const text of changes) {
    const li = document.createElement("li");
    const time = new Date().toLocaleTimeString();
    li.innerHTML = `<time>${time}</time>${escapeHtml(text)}`;
    feed.prepend(li);
  }
  // Keep the feed from growing forever.
  while (feed.children.length > 50) feed.lastChild.remove();
}

// ===================== RENDERING ==========================================

function renderItemRow(slotLabel, itemHash) {
  if (!itemHash) return `<div class="item-row"><span class="slot-label">${slotLabel}</span>-</div>`;
  const def = getItemDef(itemHash);
  const icon = iconUrl(def);
  return `
    <div class="item-row">
      <span class="slot-label">${slotLabel}</span>
      ${icon ? `<img class="item-icon" src="${icon}" alt="" />` : ""}
      <span>${escapeHtml(itemName(itemHash))}</span>
    </div>`;
}

function renderCharacter(characterId, loadout) {
  const aspectPills = loadout.aspects.map((h) => `<span class="pill">${escapeHtml(itemName(h))}</span>`).join("");
  const fragmentPills = loadout.fragments.map((h) => `<span class="pill">${escapeHtml(itemName(h))}</span>`).join("");
  const subclassName = loadout.subclassHash ? itemName(loadout.subclassHash) : "Unknown";

  return `
    <div class="character-block">
      <div class="character-title">${loadout.className}</div>
      ${renderItemRow("Kinetic", loadout.weapons.Kinetic)}
      ${renderItemRow("Energy", loadout.weapons.Energy)}
      ${renderItemRow("Power", loadout.weapons.Power)}
      ${renderItemRow("Helmet", loadout.armor.Helmet)}
      ${renderItemRow("Arms", loadout.armor.Arms)}
      ${renderItemRow("Chest", loadout.armor.Chest)}
      ${renderItemRow("Legs", loadout.armor.Legs)}
      ${renderItemRow("Class", loadout.armor.Class)}
      <div class="subclass-line"><strong>Subclass:</strong> ${escapeHtml(subclassName)}</div>
      <div class="aspect-fragment-list">${aspectPills}${fragmentPills}</div>
    </div>`;
}

// Renders (or re-renders) one player's card. `error` shows a message
// instead of loadout data, used for private profiles / rate limits / etc.
function renderPlayerCard(displayName, characterLoadouts, error) {
  const cardId = `card-${cssEscape(displayName)}`;
  let card = document.getElementById(cardId);
  if (!card) {
    card = document.createElement("div");
    card.className = "player-card";
    card.id = cardId;
    $("#players").appendChild(card);
  }

  if (error) {
    card.innerHTML = `<h2>${escapeHtml(displayName)}</h2><div class="player-error">${escapeHtml(error)}</div>`;
    return;
  }

  const characterHtml = Object.entries(characterLoadouts)
    .map(([characterId, loadout]) => renderCharacter(characterId, loadout))
    .join("");

  card.innerHTML = `<h2>${escapeHtml(displayName)}</h2>${characterHtml}`;
}

// document.querySelector ids can't contain "#" or spaces, so sanitize it.
function cssEscape(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// ===================== AUTO-DETECT TEAMMATES ==============================
// Populates ROSTER from a seed player's last reported activity, on top of
// the manual list above. Manual entries are never removed, so they still
// work as a fallback/override if auto-detection finds nothing.

function setTeammateStatus(text, isError = false) {
  const el = $("#teammate-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// Finds the newest activity instance ID across all of a member's characters.
// Each character has its own history, so we check them all and keep the
// most recent by timestamp.
async function findLatestActivityInstanceId(membership, characterIds) {
  const requests = characterIds.map((characterId) =>
    bungieFetch(
      `/Destiny2/${membership.membershipType}/Account/${membership.membershipId}` +
        `/Character/${characterId}/Stats/Activities/?count=1&mode=0&page=0`
    ).catch(() => null)
  );

  const results = await Promise.all(requests);
  let latest = null;
  for (const result of results) {
    const activity = result && result.activities && result.activities[0];
    if (activity && (!latest || new Date(activity.period) > new Date(latest.period))) {
      latest = activity;
    }
  }
  return latest ? latest.activityDetails.instanceId : null;
}

// Pulls every player out of a PostGameCarnageReport's "entries" array.
function extractTeammatesFromPgcr(pgcr) {
  const teammates = new Map(); // membershipId -> {membershipId, membershipType, displayName}

  for (const entry of pgcr.entries) {
    const info = entry.player && entry.player.destinyUserInfo;
    if (!info || !info.membershipId) continue;

    // Prefer the modern cross-platform Bungie Name; fall back for older data.
    const displayName = info.bungieGlobalDisplayName
      ? `${info.bungieGlobalDisplayName}#${String(info.bungieGlobalDisplayNameCode).padStart(4, "0")}`
      : info.displayName || `Guardian ${info.membershipId}`;

    teammates.set(info.membershipId, {
      membershipId: info.membershipId,
      membershipType: info.membershipType,
      displayName,
    });
  }

  return Array.from(teammates.values());
}

// Adds newly-found teammates to ROSTER, skipping anyone already tracked
// (matched by membershipId, checking both live entries and cached lookups).
function mergeIntoRoster(teammates) {
  const knownIds = new Set();
  const knownNames = new Set();
  for (const member of ROSTER) {
    knownNames.add(member.displayName.toLowerCase());
    if (member.membershipId) knownIds.add(member.membershipId);
    const cached = localStorage.getItem(LS_MEMBERSHIP_PREFIX + member.displayName);
    if (cached) knownIds.add(JSON.parse(cached).membershipId);
  }

  let added = 0;
  for (const teammate of teammates) {
    // Also check by name in case a manual roster entry hasn't been
    // resolved (and thus cached) yet, so we don't add it a second time.
    if (knownIds.has(teammate.membershipId) || knownNames.has(teammate.displayName.toLowerCase())) continue;

    ROSTER.push({
      displayName: teammate.displayName,
      membershipId: teammate.membershipId,
      membershipType: teammate.membershipType,
    });
    // Pre-cache the membership so resolveMembership() skips the search call.
    localStorage.setItem(
      LS_MEMBERSHIP_PREFIX + teammate.displayName,
      JSON.stringify({ membershipId: teammate.membershipId, membershipType: teammate.membershipType })
    );
    knownIds.add(teammate.membershipId);
    added++;
  }
  return added;
}

// Full flow: seed name -> membership -> latest activity -> PGCR -> roster.
async function findTeammatesFromActivity(seedName) {
  setTeammateStatus(`Looking up ${seedName}...`);
  try {
    const membership = await resolveMembership(seedName); // reuses existing resolver
    const profile = await fetchProfile(membership);
    if (!profile.characters || !profile.characters.data) {
      throw new Error("Profile is private or has no characters");
    }

    const characterIds = Object.keys(profile.characters.data);
    const instanceId = await findLatestActivityInstanceId(membership, characterIds);
    if (!instanceId) throw new Error("No recent activity history found (profile may be private)");

    const pgcr = await bungieFetch(`/Destiny2/Stats/PostGameCarnageReport/${instanceId}/`);
    const teammates = extractTeammatesFromPgcr(pgcr);
    const added = mergeIntoRoster(teammates);
    const activityName = getActivityName(pgcr.activityDetails.referenceId);

    localStorage.setItem(LS_SEED_NAME, seedName);
    setTeammateStatus(`Found ${teammates.length} teammates from last activity (${activityName}) - added ${added} new.`);

    await pollAll(); // show the new cards right away instead of waiting for the next tick
  } catch (err) {
    console.error("[d2tracker] teammate finder:", err);
    setTeammateStatus(`Error: ${err.message}`, true);
  }
}

function initTeammateFinder() {
  const savedName = localStorage.getItem(LS_SEED_NAME);
  if (savedName) $("#seed-name-input").value = savedName;

  $("#teammate-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = $("#seed-name-input").value.trim();
    if (!name) return setTeammateStatus("Enter a Bungie Name first, e.g. Name#1234.", true);
    findTeammatesFromActivity(name);
  });

  $("#refresh-teammates-btn").addEventListener("click", () => {
    const name = localStorage.getItem(LS_SEED_NAME);
    if (!name) return setTeammateStatus("No saved name yet - use 'Find' first.", true);
    findTeammatesFromActivity(name);
  });
}

// ===================== POLL LOOP ==========================================

async function processMember(member) {
  const displayName = member.displayName;
  try {
    const membership = await resolveMembership(displayName);
    const profile = await fetchProfile(membership);

    if (!profile.characters || !profile.characters.data) {
      throw new Error("Profile is private or has no characters");
    }

    const characterLoadouts = {};
    if (!lastLoadouts[displayName]) lastLoadouts[displayName] = {};

    for (const characterId of Object.keys(profile.characters.data)) {
      const loadout = buildLoadout(profile, characterId);
      characterLoadouts[characterId] = loadout;

      const changes = diffLoadouts(displayName, lastLoadouts[displayName][characterId], loadout);
      pushChanges(changes);
      lastLoadouts[displayName][characterId] = loadout;
    }

    renderPlayerCard(displayName, characterLoadouts, null);
  } catch (err) {
    // Isolated per player - one bad profile/rate limit shouldn't stop others.
    console.error(`[d2tracker] ${displayName}:`, err);
    renderPlayerCard(displayName, null, err.message);
  }
}

async function pollAll() {
  $("#status-line").textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  await Promise.allSettled(ROSTER.map(processMember));
}

// ===================== INIT ================================================

async function init() {
  if (BUNGIE_API_KEY === "PASTE_MY_KEY_HERE" || ROSTER.length === 0) {
    $("#config-warning").hidden = false;
  }

  initTeammateFinder();

  try {
    await ensureManifestLoaded();
  } catch (err) {
    console.error("[d2tracker] manifest load failed:", err);
    $("#status-line").textContent = "Failed to load Destiny manifest - see console";
    return;
  }

  await pollAll();
  setInterval(pollAll, POLL_INTERVAL_MS);
}

init();
