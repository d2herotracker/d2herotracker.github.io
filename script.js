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
 *  - GET  /Destiny2/{membershipType}/Profile/{membershipId}/?components=1000
 *      Component 1000 = ProfileTransitoryComponent, Bungie's live "session"
 *      data. Its partyMembers[] is the seed player's CURRENT fireteam -
 *      this is what "Auto-detect Teammates" is built on. It only lists bare
 *      membershipIds (no name/platform), so each one needs the next call.
 *
 *  - GET  /User/GetMembershipsById/{membershipId}/-1/
 *      Resolves a bare membershipId (no known platform) to its Bungie Name
 *      and correct membershipType. The "-1" means "search every platform."
 *
 * All requests require an X-API-Key header from a Bungie application:
 * https://www.bungie.net/en/Application
 *
 * NOTE on "Auto-detect Teammates": partyMembers reflects your fireteam at
 * the moment of the request (Bungie calls this "transitory" data - it can
 * be a few seconds stale, and is empty if you're not in an activity), so
 * click "Refresh" to re-check it - it does not update itself between polls.
 * ========================================================================= */

// ===================== CONFIG (edit this section) =======================

// The API key is NOT hardcoded here - it's entered once via the page and
// kept only in this browser's localStorage, so it never lands in git.
// Get a free key at https://www.bungie.net/en/Application
let BUNGIE_API_KEY = "";

// Empty by default so nobody is tracked automatically. Add an entry here
// only for people you want tracked every time the page loads, with no
// clicking - everyone else can be added per-session via "Auto-detect
// Teammates" on the page instead. Bungie Name format is "DisplayName#1234"
// (the number is the "code" shown on their profile).
const ROSTER = [];

const POLL_INTERVAL_MS = 45 * 1000;

// ===================== CONSTANTS =========================================

const API_ROOT = "https://www.bungie.net/Platform";
const ICON_ROOT = "https://www.bungie.net";

// Anything in the Stats group (activity history, PGCR) must go through
// stats.bungie.net directly. Via www.bungie.net those endpoints sometimes
// 30x-redirect to a plain http://stats.bungie.net URL, which a browser on
// an HTTPS page refuses to follow - it surfaces as a bare "Failed to fetch".
const STATS_ROOT = "https://stats.bungie.net/Platform";

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
const LS_API_KEY = "d2tracker.apiKey";
const LS_MANIFEST_VERSION = "d2tracker.manifestVersion";
const LS_MEMBERSHIP_PREFIX = "d2tracker.membership."; // + displayName
const LS_SEED_NAME = "d2tracker.seedName"; // last name used to find teammates
const LS_ZOOM = "d2tracker.zoom"; // page zoom percentage
const LS_STATS_COLLAPSED = "d2tracker.statsCollapsed";

// Manifest tables we cache: items turn hashes into names/icons, activities
// turn a PGCR's referenceId into "Salvation's Edge" instead of a number.
const MANIFEST_TABLES = ["DestinyInventoryItemDefinition", "DestinyActivityDefinition"];

// Page zoom, applied as the CSS `zoom` property (it reflows, unlike
// transform: scale, which would leave the page overflowing its scrollbars).
const ZOOM_MIN = 50;
const ZOOM_MAX = 150;
const ZOOM_STEP = 10;

// ===================== STATE =============================================

// Loaded at startup: tableName -> { hash (number): definition }. Starts as
// an empty table so lookups are safe even before ensureManifestLoaded() finishes.
let manifestTables = { DestinyInventoryItemDefinition: {}, DestinyActivityDefinition: {} };

// In-memory "last seen" loadout, used only to detect changes between polls.
// Shape: lastLoadouts[displayName][characterId] = loadoutObject (see below).
// Intentionally not persisted - a page refresh just starts a fresh baseline.
const lastLoadouts = {};

// Last activity we pulled a carnage report for, so the poll loop can skip
// re-fetching the same report every 45 seconds.
let lastStatsInstanceId = null;

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

// A Bungie envelope error, carrying its ErrorCode so callers can tell an
// auth failure apart from anything else.
class BungieApiError extends Error {
  constructor(message, errorCode) {
    super(message);
    this.name = "BungieApiError";
    this.errorCode = errorCode;
  }
}

// 2101 = ApiInvalidOrExpiredKey, 2102 = ApiKeyMissingFromRequest.
const API_KEY_ERROR_CODES = new Set([2101, 2102]);

// 2107 = OriginHeaderDoesNotMatchKey. Nothing wrong with the key itself -
// the browser's Origin header doesn't match the "Origin Header" field on
// the Bungie application, so the same key would work fine from elsewhere.
const ORIGIN_MISMATCH_ERROR_CODE = 2107;

// Wraps fetch() with the API key header and Bungie's envelope error format.
// ErrorCode 1 means success. Bungie sends that same envelope on failures
// *including with a 5xx status* - a bad API key comes back as HTTP 500 with
// ErrorCode 2101 - so always read the body before trusting response.status,
// or the only useful part of the error gets thrown away.
async function bungieFetch(path, options = {}) {
  const { root = API_ROOT, ...fetchOptions } = options;
  const response = await fetch(root + path, {
    ...fetchOptions,
    headers: { "X-API-Key": BUNGIE_API_KEY, ...fetchOptions.headers },
  });

  if (response.status === 429) {
    throw new Error("Rate limited by Bungie API - will retry next poll");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status} calling ${path} (no JSON body)`);
  }

  if (body.ErrorCode !== 1) {
    throw new BungieApiError(
      body.Message || body.ErrorStatus || `HTTP ${response.status} calling ${path}`,
      body.ErrorCode
    );
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} calling ${path}`);
  }
  return body.Response;
}

// /Destiny2/Manifest/ answers with ANY non-empty key, so a successful
// manifest load says nothing about whether the key is good - the app would
// start up fine and only fail on the first real call. /GlobalAlerts/ is the
// cheapest endpoint that actually validates the key.
async function validateApiKey() {
  await bungieFetch("/GlobalAlerts/");
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
// { className, weapons: {slot: itemHash}, weaponMods: {slot: [hash...]},
//   armor: {slot: itemHash}, armorMods: {slot: [hash...]}, subclassHash,
//   aspects: [hash...], fragments: [hash...] }
function buildLoadout(profile, characterId) {
  const character = profile.characters.data[characterId];
  const equipment = profile.characterEquipment.data[characterId].items;
  const sockets = profile.itemComponents.sockets.data;

  const loadout = {
    className: CLASS_NAMES[character.classType] || "Unknown",
    weapons: {},
    weaponMods: {},
    armor: {},
    armorMods: {},
    subclassHash: null,
    aspects: [],
    fragments: [],
  };

  for (const item of equipment) {
    if (WEAPON_BUCKETS[item.bucketHash]) {
      const slot = WEAPON_BUCKETS[item.bucketHash];
      loadout.weapons[slot] = item.itemHash;
      loadout.weaponMods[slot] = collectMods(sockets[item.itemInstanceId], "Weapon Mod");
    } else if (ARMOR_BUCKETS[item.bucketHash]) {
      const slot = ARMOR_BUCKETS[item.bucketHash];
      loadout.armor[slot] = item.itemHash;
      loadout.armorMods[slot] = collectMods(sockets[item.itemInstanceId], "Armor Mod");
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
// Bungie labels these per-element (e.g. "Solar Aspect", "Void Fragment"),
// so check the suffix rather than an exact match.
function classifyPlug(plugHash, loadout) {
  const def = getItemDef(plugHash);
  if (!def || !def.displayProperties || !def.displayProperties.name) return;
  const type = def.itemTypeDisplayName || "";

  if (type.endsWith("Aspect")) loadout.aspects.push(plugHash);
  else if (type.endsWith("Fragment")) loadout.fragments.push(plugHash);
}

// Finds equipped mod plugs in one item's sockets - `typeSuffix` is
// "Weapon Mod" or "Armor Mod" (Bungie prefixes these, e.g. "Helmet Armor
// Mod"). Skips "Empty ... Socket" placeholders, shaders, and ornaments.
function collectMods(socketData, typeSuffix) {
  const mods = [];
  if (!socketData) return mods;

  for (const socket of socketData.sockets) {
    const def = getItemDef(socket.plugHash);
    if (!def || !def.displayProperties || !def.displayProperties.name) continue;
    if (def.displayProperties.name.startsWith("Empty")) continue;
    if ((def.itemTypeDisplayName || "").endsWith(typeSuffix)) mods.push(socket.plugHash);
  }
  return mods;
}

// ===================== DIFF DETECTION =====================================

// Compares one slot->[hash...] mod map against another (weapons or armor)
// and appends "X equipped mod Y (slot)" lines for anything newly plugged.
function diffModSlots(displayName, prevMods, currMods, labelSuffix, changes) {
  for (const slot of Object.keys(currMods)) {
    const prevHashes = (prevMods && prevMods[slot]) || [];
    for (const hash of currMods[slot]) {
      if (!prevHashes.includes(hash)) {
        changes.push(`${displayName} equipped mod ${itemName(hash)} (${slot}${labelSuffix})`);
      }
    }
  }
}

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

  diffModSlots(displayName, prev.weaponMods, curr.weaponMods, "", changes);
  diffModSlots(displayName, prev.armorMods, curr.armorMods, " armor", changes);

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

// `modHashes` (optional) renders as a row of small pills right under the
// item, so each weapon/armor piece shows its own mods instead of one
// combined list at the bottom.
function renderItemRow(slotLabel, itemHash, modHashes) {
  if (!itemHash) return `<div class="item-row"><span class="slot-label">${slotLabel}</span>-</div>`;
  const def = getItemDef(itemHash);
  const icon = iconUrl(def);
  const modPills = (modHashes || []).map(renderPill).join("");
  return `
    <div class="item-row">
      <span class="slot-label">${slotLabel}</span>
      ${icon ? `<img class="item-icon" src="${icon}" alt="" />` : ""}
      <span>${escapeHtml(itemName(itemHash))}</span>
    </div>
    ${modPills ? `<div class="mod-row">${modPills}</div>` : ""}`;
}

// Small icon + name pill, shared by mods, aspects, and fragments.
function renderPill(hash) {
  const def = getItemDef(hash);
  const icon = iconUrl(def);
  return `<span class="pill">${icon ? `<img class="pill-icon" src="${icon}" alt="" />` : ""}${escapeHtml(itemName(hash))}</span>`;
}

function renderCharacter(characterId, loadout) {
  const aspectPills = loadout.aspects.map(renderPill).join("");
  const fragmentPills = loadout.fragments.map(renderPill).join("");
  const subclassDef = loadout.subclassHash ? getItemDef(loadout.subclassHash) : null;
  const subclassIcon = iconUrl(subclassDef);
  const subclassName = loadout.subclassHash ? itemName(loadout.subclassHash) : "Unknown";

  return `
    <div class="character-block">
      <div class="character-title">${loadout.className}</div>
      ${renderItemRow("Kinetic", loadout.weapons.Kinetic, loadout.weaponMods.Kinetic)}
      ${renderItemRow("Energy", loadout.weapons.Energy, loadout.weaponMods.Energy)}
      ${renderItemRow("Power", loadout.weapons.Power, loadout.weaponMods.Power)}
      ${renderItemRow("Helmet", loadout.armor.Helmet, loadout.armorMods.Helmet)}
      ${renderItemRow("Arms", loadout.armor.Arms, loadout.armorMods.Arms)}
      ${renderItemRow("Chest", loadout.armor.Chest, loadout.armorMods.Chest)}
      ${renderItemRow("Legs", loadout.armor.Legs, loadout.armorMods.Legs)}
      ${renderItemRow("Class", loadout.armor.Class, loadout.armorMods.Class)}
      <div class="subclass-line">
        ${subclassIcon ? `<img class="item-icon" src="${subclassIcon}" alt="" />` : ""}
        <strong>Subclass:</strong> ${escapeHtml(subclassName)}
      </div>
      <div class="pill-row"><span class="slot-label">Aspects</span><div class="aspect-fragment-list">${aspectPills || "-"}</div></div>
      <div class="pill-row"><span class="slot-label">Fragments</span><div class="aspect-fragment-list">${fragmentPills || "-"}</div></div>
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
// Populates ROSTER from a seed player's CURRENT live fireteam, on top of
// the manual list above. Manual entries are never removed, so they still
// work as a fallback/override if auto-detection finds nobody.

function setTeammateStatus(text, isError = false) {
  const el = $("#teammate-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// Reads component 1000, which carries both the live partyMembers[] and the
// activity they're in right now. Each party entry is just a bare
// membershipId - no name or platform - see resolveMembershipFromRawId.
async function fetchCurrentFireteam(membership) {
  const path = `/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=1000`;
  const profile = await bungieFetch(path);
  const transitory = profile.profileTransitoryData && profile.profileTransitoryData.data;
  if (!transitory) throw new Error("Current fireteam data isn't available (private profile)");
  return {
    partyMembers: transitory.partyMembers || [],
    currentActivity: transitory.currentActivity || null,
  };
}

// Turns a bare membershipId from partyMembers[] into a full {membershipId,
// membershipType, displayName}, since that ID alone isn't enough to poll.
async function resolveMembershipFromRawId(rawMembershipId) {
  const result = await bungieFetch(`/User/GetMembershipsById/${rawMembershipId}/-1/`);
  const match = result.destinyMemberships.find((m) => m.membershipId === rawMembershipId) || result.destinyMemberships[0];

  const displayName = match.bungieGlobalDisplayName
    ? `${match.bungieGlobalDisplayName}#${String(match.bungieGlobalDisplayNameCode).padStart(4, "0")}`
    : match.displayName;

  return { membershipId: match.membershipId, membershipType: match.membershipType, displayName };
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

// Full flow: seed name -> membership -> live partyMembers -> resolve each -> roster.
async function findCurrentFireteam(seedName) {
  setTeammateStatus(`Looking up ${seedName}'s current fireteam...`);
  try {
    const membership = await resolveMembership(seedName); // reuses existing resolver
    const { partyMembers } = await fetchCurrentFireteam(membership);
    if (!partyMembers.length) {
      throw new Error("No current fireteam found - they may be offline or not in an activity");
    }

    const resolved = await Promise.all(
      partyMembers.map((pm) => resolveMembershipFromRawId(pm.membershipId).catch(() => null))
    );
    const teammates = resolved.filter(Boolean);
    const added = mergeIntoRoster(teammates);

    localStorage.setItem(LS_SEED_NAME, seedName);
    setTeammateStatus(`Found ${teammates.length} players in current fireteam - added ${added} new.`);

    await pollAll(); // show the new cards right away instead of waiting for the next tick
  } catch (err) {
    console.error("[d2tracker] fireteam finder:", err);
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
    findCurrentFireteam(name);
  });

  $("#refresh-teammates-btn").addEventListener("click", () => {
    const name = localStorage.getItem(LS_SEED_NAME);
    if (!name) return setTeammateStatus("No saved name yet - use 'Find' first.", true);
    findCurrentFireteam(name);
  });
}

// ===================== FIRETEAM STATS (POST-GAME) =========================
// Bungie exposes NO live per-player kills/deaths/assists - component 1000's
// currentActivity carries only score and player count. Per-player numbers
// exist solely in the post-game carnage report, which isn't written until
// the activity ends. So this panel shows the last COMPLETED activity, with
// a header line for whatever the fireteam is in right now.

// Most recent activity for a character. mode=0 means "any activity type".
async function fetchLastActivityId(membership, characterId) {
  const path =
    `/Destiny2/${membership.membershipType}/Account/${membership.membershipId}` +
    `/Character/${characterId}/Stats/Activities/?count=1&mode=0&page=0`;
  const history = await bungieFetch(path, { root: STATS_ROOT });
  const activities = history.activities || [];
  return activities.length ? activities[0].activityDetails.instanceId : null;
}

async function fetchCarnageReport(instanceId) {
  return bungieFetch(`/Destiny2/Stats/PostGameCarnageReport/${instanceId}/`, { root: STATS_ROOT });
}

// Every stat lives at values[name].basic.value; a missing entry reads as 0
// rather than throwing, since not every mode reports every stat.
function statValue(values, name) {
  const stat = values && values[name];
  return stat && stat.basic ? stat.basic.value : 0;
}

// Turns a carnage report into one plain row per fireteam member, highest
// kills first. Pure function of the report - kept separate from rendering so
// it can be tested against a real saved PGCR with no network and no DOM.
function buildStatsRows(report) {
  const rows = (report.entries || []).map((entry) => {
    const player = entry.player || {};
    const info = player.destinyUserInfo || {};
    const values = entry.values || {};
    const timePlayed = values.timePlayedSeconds && values.timePlayedSeconds.basic;

    return {
      displayName: info.bungieGlobalDisplayName
        ? `${info.bungieGlobalDisplayName}#${String(info.bungieGlobalDisplayNameCode).padStart(4, "0")}`
        : info.displayName || "Unknown",
      membershipId: info.membershipId || "",
      className: player.characterClass || "",
      light: player.lightLevel || 0,
      kills: statValue(values, "kills"),
      deaths: statValue(values, "deaths"),
      assists: statValue(values, "assists"),
      kd: statValue(values, "killsDeathsRatio"),
      kda: statValue(values, "killsDeathsAssists"),
      timePlayed: timePlayed ? timePlayed.displayValue : "",
      completed: statValue(values, "completed") === 1,
    };
  });

  return rows.sort((a, b) => b.kills - a.kills);
}

function activityName(referenceId) {
  const def = manifestTables.DestinyActivityDefinition[referenceId];
  return def && def.displayProperties && def.displayProperties.name
    ? def.displayProperties.name
    : "Unknown activity";
}

// currentActivity has a startTime but no activity hash, so the live line can
// report elapsed time and headcount - never what they're actually playing.
function describeLiveActivity(currentActivity) {
  if (!currentActivity || !currentActivity.startTime) return "Not in an activity right now.";

  const minutes = Math.max(0, Math.round((Date.now() - new Date(currentActivity.startTime).getTime()) / 60000));
  const elapsed = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  const parts = [`In an activity - started ${elapsed} ago`];
  if (currentActivity.numberOfPlayers) parts.push(`${currentActivity.numberOfPlayers} players`);
  if (currentActivity.score) parts.push(`score ${currentActivity.score.toLocaleString()}`);
  return parts.join(" \u00b7 ");
}

const STATS_COLUMNS = ["Player", "Class", "Light", "Kills", "Deaths", "Assists", "K/D", "KDA", "Time", "Done"];

function renderStatsTable(rows, seedName) {
  const header = STATS_COLUMNS.map((label) => `<th>${label}</th>`).join("");

  const body = rows
    .map((row) => {
      const isSeed = seedName && row.displayName.toLowerCase() === seedName.toLowerCase();
      return `<tr${isSeed ? ' class="stats-seed"' : ""}>` +
        `<td class="stats-name">${escapeHtml(row.displayName)}</td>` +
        `<td>${escapeHtml(row.className)}</td>` +
        `<td>${row.light}</td>` +
        `<td>${row.kills}</td>` +
        `<td>${row.deaths}</td>` +
        `<td>${row.assists}</td>` +
        `<td>${row.kd.toFixed(2)}</td>` +
        `<td>${row.kda.toFixed(2)}</td>` +
        `<td>${escapeHtml(row.timePlayed)}</td>` +
        `<td>${row.completed ? '<span class="stats-done">Yes</span>' : "No"}</td>` +
        `</tr>`;
    })
    .join("");

  return `<table id="stats-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function setStatsStatus(text, isError = false) {
  const el = $("#stats-status");
  el.textContent = text || "";
  el.classList.toggle("error", isError);
  el.hidden = !text;
}

// Pulls the panel's data. Isolated in its own try/catch (like processMember)
// so a stats failure never blanks the loadout cards.
async function refreshStats() {
  const seedName = localStorage.getItem(LS_SEED_NAME);
  if (!seedName) return;

  $("#stats-panel").hidden = false;

  try {
    const membership = await resolveMembership(seedName);

    // One profile call covers both halves: characters (to find whichever one
    // they last played) and the live activity for the header line.
    const profile = await bungieFetch(
      `/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=200,1000`
    );
    const transitory = profile.profileTransitoryData && profile.profileTransitoryData.data;
    $("#stats-live").textContent = describeLiveActivity(transitory && transitory.currentActivity);

    if (!profile.characters || !profile.characters.data) {
      throw new Error(`${seedName}'s profile is private - no activity history available`);
    }

    const characterId = getActiveCharacterId(profile.characters.data);
    const instanceId = await fetchLastActivityId(membership, characterId);
    if (!instanceId) {
      setStatsStatus("No completed activities found for this character yet.");
      return;
    }

    // A finished activity's report never changes, so re-fetching the same
    // instanceId every 45s would be pure waste.
    if (instanceId === lastStatsInstanceId) return;

    const report = await fetchCarnageReport(instanceId);
    const rows = buildStatsRows(report);

    $("#stats-subtitle").textContent =
      `${activityName(report.activityDetails.referenceId)} - finished ${new Date(report.period).toLocaleString()}`;
    $("#stats-table-wrap").innerHTML = renderStatsTable(rows, seedName);
    setStatsStatus("");
    lastStatsInstanceId = instanceId;
  } catch (err) {
    console.error("[d2tracker] stats panel:", err);
    setStatsStatus(`Stats unavailable: ${err.message}`, true);
  }
}

function initStatsPanel() {
  const body = $("#stats-body");
  const toggle = $("#stats-toggle");

  function applyCollapsed(collapsed) {
    body.hidden = collapsed;
    toggle.textContent = collapsed ? "Show" : "Hide";
    toggle.setAttribute("aria-expanded", String(!collapsed));
  }

  applyCollapsed(localStorage.getItem(LS_STATS_COLLAPSED) === "true");

  toggle.addEventListener("click", () => {
    const collapsed = !body.hidden;
    localStorage.setItem(LS_STATS_COLLAPSED, String(collapsed));
    applyCollapsed(collapsed);
  });
}

// ===================== PAGE ZOOM ==========================================
// Scales the whole page so a six-person fireteam fits on one screen. Uses the
// CSS `zoom` property because it reflows the layout; transform: scale would
// leave the page overflowing its own scrollbars. Native Ctrl+scroll browser
// zoom is deliberately left alone.

function applyZoom(percent) {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, percent));
  document.body.style.zoom = `${clamped}%`;
  $("#zoom-level").textContent = `${clamped}%`;
  localStorage.setItem(LS_ZOOM, String(clamped));
  return clamped;
}

function initZoomControls() {
  let current = applyZoom(Number(localStorage.getItem(LS_ZOOM)) || 100);

  $("#zoom-out").addEventListener("click", () => {
    current = applyZoom(current - ZOOM_STEP);
  });
  $("#zoom-in").addEventListener("click", () => {
    current = applyZoom(current + ZOOM_STEP);
  });
  $("#zoom-reset").addEventListener("click", () => {
    current = applyZoom(100);
  });
}

// ===================== POLL LOOP ==========================================

// dateLastPlayed is an ISO timestamp string, so plain string comparison
// sorts it correctly - no need to parse it into a Date first.
function getActiveCharacterId(charactersData) {
  return Object.keys(charactersData).reduce(
    (latest, id) => (!latest || charactersData[id].dateLastPlayed > charactersData[latest].dateLastPlayed ? id : latest),
    null
  );
}

async function processMember(member) {
  const displayName = member.displayName;
  try {
    const membership = await resolveMembership(displayName);
    const profile = await fetchProfile(membership);

    if (!profile.characters || !profile.characters.data) {
      throw new Error("Profile is private or has no characters");
    }

    // Only show whichever character they last played - not all three.
    const characterId = getActiveCharacterId(profile.characters.data);
    const loadout = buildLoadout(profile, characterId);

    if (!lastLoadouts[displayName]) lastLoadouts[displayName] = {};
    const changes = diffLoadouts(displayName, lastLoadouts[displayName][characterId], loadout);
    pushChanges(changes);
    lastLoadouts[displayName][characterId] = loadout;

    renderPlayerCard(displayName, { [characterId]: loadout }, null);
  } catch (err) {
    // Isolated per player - one bad profile/rate limit shouldn't stop others.
    console.error(`[d2tracker] ${displayName}:`, err);
    renderPlayerCard(displayName, null, err.message);
  }
}

async function pollAll() {
  $("#status-line").textContent = `Last updated ${new Date().toLocaleTimeString()}`;
  // Stats ride along with the player cards - allSettled keeps one failing
  // half from taking down the other.
  await Promise.allSettled([...ROSTER.map(processMember), refreshStats()]);
}

// ===================== INIT ================================================

// Everything below only runs once a key is available - see initApiKeyGate().
async function startApp() {
  $("#teammate-finder").hidden = false;
  $("main").hidden = false;
  $("#change-key-btn").hidden = false;

  initTeammateFinder();
  initStatsPanel();

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

// Shows the "enter your API key" box until a key that Bungie accepts is
// saved in localStorage, then starts the app. A saved key is re-checked on
// every load, because a key can be revoked or expire after it was stored.
// "Change API Key" just clears it and reloads - simpler than trying to
// reset in-memory state mid-session.
function initApiKeyGate() {
  const saved = localStorage.getItem(LS_API_KEY);

  function setKeyMessage(message, isError) {
    const el = $("#api-key-error");
    el.textContent = message || "";
    el.classList.toggle("error", Boolean(isError));
    el.hidden = !message;
  }

  // Only saves the key once Bungie has confirmed it works, so a bad key
  // never gets stored and re-used silently on the next load.
  // Only an actually-bad key is worth throwing away - an origin mismatch or
  // an outage means the key is fine and re-pasting it would fix nothing, so
  // keep it and let a reload retry once the app settings are corrected.
  function explainKeyFailure(err) {
    if (API_KEY_ERROR_CODES.has(err.errorCode)) {
      return {
        discardKey: true,
        message:
          "Bungie rejected that API key (invalid or expired). Create a new one at bungie.net/en/Application and paste it here.",
      };
    }
    if (err.errorCode === ORIGIN_MISMATCH_ERROR_CODE) {
      return {
        discardKey: false,
        message:
          `The key is valid, but Bungie is blocking requests from this page. Open your app at ` +
          `bungie.net/en/Application and set its "Origin Header" field to exactly ${location.origin} ` +
          `(or * to allow any origin), then reload. Note it must be the page's origin, not the ` +
          `"Website" field.`,
      };
    }
    return { discardKey: false, message: `Could not verify the key: ${err.message}` };
  }

  async function useKey(key) {
    BUNGIE_API_KEY = key;
    setKeyMessage("Checking key with Bungie...", false);

    try {
      await validateApiKey();
    } catch (err) {
      console.error("[d2tracker] API key check failed:", err);
      const { discardKey, message } = explainKeyFailure(err);
      if (discardKey) {
        BUNGIE_API_KEY = "";
        localStorage.removeItem(LS_API_KEY);
        $("#api-key-input").value = "";
      }
      $("#api-key-section").hidden = false;
      setKeyMessage(message, true);
      return;
    }

    localStorage.setItem(LS_API_KEY, key);
    setKeyMessage("", false);
    $("#api-key-section").hidden = true;
    startApp();
  }

  $("#api-key-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const key = $("#api-key-input").value.trim();
    if (!key) return;
    useKey(key);
  });

  $("#change-key-btn").addEventListener("click", () => {
    localStorage.removeItem(LS_API_KEY);
    location.reload();
  });

  if (saved) useKey(saved);
}

// Zoom is pure DOM, so it works before a key is entered - unlike everything
// in startApp(), which needs the API.
initZoomControls();
initApiKeyGate();
