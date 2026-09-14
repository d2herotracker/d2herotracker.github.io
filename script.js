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

const BUNGIE_API_KEY = "1467c5e9a32e4ee4ba7c85669025b5e4";

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

// Manifest tables we cache - just items, for turning hashes into names/icons.
const MANIFEST_TABLES = ["DestinyInventoryItemDefinition"];

// ===================== STATE =============================================

// Loaded at startup: tableName -> { hash (number): definition }. Starts as
// an empty table so lookups are safe even before ensureManifestLoaded() finishes.
let manifestTables = { DestinyInventoryItemDefinition: {} };

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
//   armorMods: [hash...], subclassHash, aspects: [hash...], fragments: [hash...] }
function buildLoadout(profile, characterId) {
  const character = profile.characters.data[characterId];
  const equipment = profile.characterEquipment.data[characterId].items;
  const sockets = profile.itemComponents.sockets.data;

  const loadout = {
    className: CLASS_NAMES[character.classType] || "Unknown",
    weapons: {},
    armor: {},
    armorMods: [],
    subclassHash: null,
    aspects: [],
    fragments: [],
  };

  for (const item of equipment) {
    if (WEAPON_BUCKETS[item.bucketHash]) {
      loadout.weapons[WEAPON_BUCKETS[item.bucketHash]] = item.itemHash;
    } else if (ARMOR_BUCKETS[item.bucketHash]) {
      loadout.armor[ARMOR_BUCKETS[item.bucketHash]] = item.itemHash;
      collectArmorMods(sockets[item.itemInstanceId], loadout.armorMods);
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

// Pushes any equipped "<Slot> Armor Mod" plugs from one armor piece's
// sockets - this skips shaders, ornaments, and masterwork sockets, which
// use different itemTypeDisplayName values (e.g. "Shader", "").
function collectArmorMods(socketData, armorMods) {
  if (!socketData) return;
  for (const socket of socketData.sockets) {
    const def = getItemDef(socket.plugHash);
    if (def && def.itemTypeDisplayName && def.itemTypeDisplayName.endsWith("Armor Mod")) {
      armorMods.push(socket.plugHash);
    }
  }
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

  for (const hash of curr.armorMods) {
    if (!prev.armorMods.includes(hash)) changes.push(`${displayName} equipped mod ${itemName(hash)}`);
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

// Small icon + name pill, shared by aspects and fragments.
function renderPill(hash) {
  const def = getItemDef(hash);
  const icon = iconUrl(def);
  return `<span class="pill">${icon ? `<img class="pill-icon" src="${icon}" alt="" />` : ""}${escapeHtml(itemName(hash))}</span>`;
}

function renderCharacter(characterId, loadout) {
  const modPills = loadout.armorMods.map(renderPill).join("");
  const aspectPills = loadout.aspects.map(renderPill).join("");
  const fragmentPills = loadout.fragments.map(renderPill).join("");
  const subclassDef = loadout.subclassHash ? getItemDef(loadout.subclassHash) : null;
  const subclassIcon = iconUrl(subclassDef);
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
      <div class="pill-row"><span class="slot-label">Mods</span><div class="aspect-fragment-list">${modPills || "-"}</div></div>
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

// Reads the live partyMembers[] off component 1000. Each entry is just a
// bare membershipId - no name or platform - see resolveMembershipFromRawId.
async function fetchCurrentFireteam(membership) {
  const path = `/Destiny2/${membership.membershipType}/Profile/${membership.membershipId}/?components=1000`;
  const profile = await bungieFetch(path);
  const transitory = profile.profileTransitoryData && profile.profileTransitoryData.data;
  if (!transitory) throw new Error("Current fireteam data isn't available (private profile)");
  return transitory.partyMembers || [];
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
    const partyMembers = await fetchCurrentFireteam(membership);
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
  await Promise.allSettled(ROSTER.map(processMember));
}

// ===================== INIT ================================================

async function init() {
  // An empty ROSTER is a valid setup now (auto-detect-only usage), so only
  // warn about the API key - that one's required no matter what.
  if (BUNGIE_API_KEY === "PASTE_MY_KEY_HERE") {
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
