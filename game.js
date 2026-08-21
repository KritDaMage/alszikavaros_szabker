// Game engine: state management, phase transitions, event log.
// Does not touch the DOM - the <script> block in index.html calls the Game.* functions
// and gets notified via the Game.onChange callback whenever the UI needs to re-render.
// Assumes roles.js is already loaded (global ROLES variable).

const Game = (() => {
  const STORAGE_KEY = 'alszikavaros_szabker_state_v1';

  const PHASES = {
    HOME: 'home',
    SETUP: 'setup',
    ASSIGN: 'assign',
    NIGHT: 'night',
    DAY: 'day',
    ENDED: 'ended',
  };

  let state = null;
  let onChange = null;

  function freshState() {
    return {
      players: [], // { id, name, roleId, alive }
      round: 0,
      phase: PHASES.HOME,
      assignmentQueue: [], // roleIds still waiting for a player during the "0. éjszaka" manual assignment
      assignmentTotalCounts: {}, // roleId -> how many were originally requested this game
      assignmentHistory: [], // [{ roleId, playerIds }] completed steps, for the "Vissza" button
      assignmentWasManual: false, // true if beginRoleAssignment() (role-by-role) produced the
                                   // current roster, false for autoAssignRoles() (instant shuffle) -
                                   // the "Szerepek kiosztva" roster only allows tap-to-swap when
                                   // this is false, since manual assignment already has its own
                                   // "Vissza" undo and roles get announced as they're handed out.
      nightRoleOrder: [], // fixed roleId order for the whole night (see beginNight()) -
                           // doesn't shrink as roles get decided, so a role's spot in it
                           // never changes no matter how much the narrator jumps around
      nightCursor: 0, // index into nightRoleOrder - which role's screen is showing right
                       // now, or exactly nightRoleOrder.length once every role's been
                       // stepped past (currentNightRole() then returns null - index.html
                       // shows the end-of-night summary there instead of resolving right
                       // away, see finishNight()). Purely a "where are we looking" pointer:
                       // stepping back, jumping to any step (jumpToNightStep), confirming,
                       // or skipping only ever move this - none of them touch nightActions
                       // for any role other than the one currently at this position, so
                       // revisiting an earlier step can never lose a later one's pick.
      nightVisited: [], // roleIds that have actually been confirmed or skipped PAST at
                         // least once THIS night (see advanceNightCursor()) - only grows,
                         // never shrinks when the narrator steps back or jumps to an
                         // earlier/later role, so index.html's progress row can keep
                         // showing a role as decided (and whether it acted or was skipped)
                         // no matter where nightCursor currently sits. Also what
                         // advanceNightCursor() checks to decide whether "Következő" should
                         // loop back to a role the narrator jumped straight past without
                         // ever landing on, instead of quietly finishing with it untouched.
      nightForcedSkipped: [], // roleIds whose MOST RECENT skip (see skipNightAction()) happened
                               // with no living, non-abducted holder to even ask - as opposed to
                               // a real "Kihagyás" the narrator chose with an actual actor
                               // available. index.html's progress row uses this to avoid showing
                               // a forced pass-through as a deliberate skip: if the UFO's target
                               // later moves off this role's holder, it stops looking "decided"
                               // instead of staying stuck amber for a choice nobody was ever
                               // offered. Removed again the moment a real skip/pick happens
                               // while an actor IS available (see skipNightAction()/record*()).
      nightActions: {}, // roleId -> { targetId } (or the shape each role's recordXAction
                         // uses) - a flat, order-independent record of every role's pick
                         // this night, present only for roles that have actually been
                         // decided (confirmed or skipped past) so far.
      abductedIds: [], // playerIds untouchable this night - always freshly recomputed from
                        // nightActions (see recomputeAbductedIds()), never hand-mutated -
                        // the UFO's target, plus anyone Cupido links to an already-abducted
                        // player (chain reaction). Can't be targeted, and their own night
                        // action (if any) is voided, for this night only.
      pendingDeaths: [], // result of the current night's resolution, until announced
      dayEliminatedIds: [], // playerIds eliminatePlayer() has voted out THIS day so far -
                             // no cap, so this can grow past one (see eliminatePlayer()).
                             // index.html shows each as its own coffin banner;
                             // reopenDayVote()'s "Vissza" only ever undoes the LAST one.
      roundHistory: [], // [{ round, nightActions, abductedIds, aliveIds: [playerId],
                        //    dayDeaths: [{playerId, cause: 'vote'|'hunter'}] }] - one entry per
                        // round, pushed by resolveNight() (see its own comment there) and
                        // appended to across that round's day phase - the ended screen's
                        // paginated per-round history reads this.
      pendingHunterShot: null, // playerId of a just-eliminated Vadász, waiting for their shot target
      pendingMaim: [], // [{ targetId, bodyPart: 'kez' | 'nyelv' }] - Csonkoló's victim(s) for
                        // the upcoming day only (2 if Cupido's bond dragged in a partner).
                        // Overwritten fresh every resolveNight().
      pekHungerStreak: 0, // consecutive rounds in a row NOBODY actually got bread - abducted,
                          // dead, or just skipped, it doesn't matter why (see resolveNight()) -
                          // resets to 0 the moment bread IS given, even on the same round the
                          // Pék then dies from something else that same night. Only ever moves
                          // if a Pék actually exists in this game.
      katonaShieldLostRound: null, // round a Katona's shield got consumed blocking a kill,
                                    // or null - lets the Day screen announce it just once,
                                    // the same morning it happened (see resolveNight()).
      winner: null, // null | 'polgarok' | 'gyilkosok' | 'solo'
      winReason: null, // null | 'gyilkosok_elfogytak' | 'gyilkosok_tobbsegben' | 'starvation' | 'solo' -
                        // why the game ended, for the ended screen's explanation line (see
                        // deriveWinReason())
      soloWinnerId: null, // playerId, only set when winner === 'solo' (e.g. Gyári munkás)
      killsPerNight: 1, // how many targets the gyilkosok pick together each night - set at setup
      dayTimerMinutes: 7, // length of the day discussion timer - set at setup
    };
  }

  function setKillsPerNight(n) {
    state.killsPerNight = Math.max(1, Math.round(Number(n)) || 1);
    save();
  }

  function setDayTimerMinutes(n) {
    state.dayTimerMinutes = Math.max(1, Math.round(Number(n)) || 7);
    save();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      // localStorage unavailable (e.g. private browsing) - not critical, just won't persist
    }
    if (onChange) onChange(state);
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // Merge onto freshState() rather than using the parsed save as-is - a save
      // from before some field existed (e.g. killsPerNight/dayTimerMinutes) would
      // otherwise load with that field missing/undefined instead of its default.
      state = raw ? { ...freshState(), ...JSON.parse(raw) } : freshState();
    } catch (e) {
      state = freshState();
    }
    return state;
  }

  function getRole(roleId) {
    return ROLES.find((r) => r.id === roleId) || null;
  }

  function alivePlayers() {
    return state.players.filter((p) => p.alive);
  }

  // The configured killsPerNight, clamped to how many living players actually
  // exist tonight. Without this, a killsPerNight set higher than the surviving
  // population (only possible once the game has shrunk well past its start, since
  // checkWinCondition() ends the game once gyilkosok >= masok) would leave the
  // Gyilkos permanently unable to reach the exact target count the UI asks for -
  // stuck skipping forever instead of ever killing again.
  function killCapacity() {
    return Math.min(state.killsPerNight || 1, alivePlayers().length);
  }

  // ---- Home phase ----

  function enterSetup() {
    if (state.phase !== PHASES.HOME) return;
    state.phase = PHASES.SETUP;
    save();
  }

  // ---- Setup phase ----

  function newPlayer(name) {
    return {
      id: 'p' + Date.now() + Math.random().toString(36).slice(2, 7),
      name,
      roleId: null,
      alive: true,
      shieldUsed: false, // only meaningful if this player ends up holding a hasShield
                         // role (Katona) - true once their shield has blocked a kill
                         // (see resolveNight()), permanently, for the rest of the game.
    };
  }

  function addPlayer(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    state.players.push(newPlayer(trimmed));
    save();
  }

  function removePlayer(id) {
    state.players = state.players.filter((p) => p.id !== id);
    save();
  }

  // Manual role assignment ("0. éjszaka"): instead of a random shuffle, the narrator
  // goes role by role - just like a real night - and picks who gets each one. The
  // queue holds each DISTINCT role once, in ROLE_ORDER (roles.js) - the same order
  // the post-assignment roster/night summary/ended screen display everyone in, so
  // roles get asked for in the order they're later shown in; roles with more than
  // one slot (e.g. 2 gyilkos) are filled all at once from a single screen instead
  // of one-at-a-time. Whoever is left once the queue is empty becomes fillerRoleId.
  //
  // roleCounts: { roleId: count } - any roles not listed (typically 'polgar', which
  // is never queued - it's always the leftover filler) get 0.
  function beginRoleAssignment(roleCounts, fillerRoleId = 'polgar') {
    ROLES.filter((r) => typeof r.minCount === 'number').forEach((r) => {
      if ((roleCounts[r.id] || 0) < r.minCount) {
        throw new Error(`Legalább ${r.minCount} ${r.name} kell.`);
      }
    });

    const distinctRoles = [...ROLES]
      .filter((r) => r.id !== fillerRoleId && (roleCounts[r.id] || 0) > 0)
      .sort((a, b) => {
        const ia = ROLE_ORDER.indexOf(a.id);
        const ib = ROLE_ORDER.indexOf(b.id);
        return (ia === -1 ? ROLE_ORDER.length : ia) - (ib === -1 ? ROLE_ORDER.length : ib);
      })
      .map((r) => r.id);

    const totalSlots = distinctRoles.reduce((sum, id) => sum + (roleCounts[id] || 0), 0);
    if (totalSlots > state.players.length) {
      throw new Error('Több szerep lett megadva, mint ahány játékos van.');
    }

    state.players.forEach((p) => { p.roleId = null; p.alive = true; p.shieldUsed = false; });
    state.assignmentQueue = distinctRoles;
    state.assignmentTotalCounts = { ...roleCounts };
    state.assignmentHistory = [];
    state.assignmentWasManual = true;
    state.phase = PHASES.ASSIGN;
    save();
  }

  function currentAssignmentRole() {
    if (state.phase !== PHASES.ASSIGN || state.assignmentQueue.length === 0) return null;
    return getRole(state.assignmentQueue[0]);
  }

  function unassignedPlayers() {
    return state.players.filter((p) => !p.roleId);
  }

  // Assigns the current role to every player in playerIds at once - there must be
  // exactly as many as the role's configured count (the UI is expected to enforce
  // this before calling in, but it's double-checked here too).
  function assignRoleToPlayers(playerIds, fillerRoleId = 'polgar') {
    const role = currentAssignmentRole();
    if (!role) return;
    const needed = state.assignmentTotalCounts[role.id] || 1;
    const uniqueIds = [...new Set(playerIds)].filter((id) => {
      const p = state.players.find((pl) => pl.id === id);
      return p && !p.roleId;
    });
    if (uniqueIds.length !== needed) return;

    uniqueIds.forEach((id) => {
      const p = state.players.find((pl) => pl.id === id);
      p.roleId = role.id;
    });
    state.assignmentHistory.push({ roleId: role.id, playerIds: uniqueIds });
    state.assignmentQueue.shift();

    if (state.assignmentQueue.length === 0) {
      // Stay in ASSIGN (renderAssign shows a "Játék indítása" screen once the queue
      // is empty) instead of dropping back to the full SETUP screen.
      const filledIds = [];
      state.players.forEach((p) => {
        if (!p.roleId) {
          p.roleId = fillerRoleId;
          filledIds.push(p.id);
        }
      });
      // Recorded as its own history step too (isFillerFill), even though the
      // narrator never explicitly confirmed it - otherwise stepBackAssignment()
      // from the "Szerepek kiosztva" summary would only undo the last REAL role
      // and leave these players stuck holding fillerRoleId, unselectable for
      // whatever gets reassigned.
      if (filledIds.length > 0) {
        state.assignmentHistory.push({ roleId: fillerRoleId, playerIds: filledIds, isFillerFill: true });
      }
    }
    save();
  }

  // Instant random shuffle - the classic alternative to the manual role-by-role flow.
  // roleCounts: { roleId: count } - any roles not listed (typically 'polgar') fill
  // the remaining players.
  function autoAssignRoles(roleCounts, fillerRoleId = 'polgar') {
    ROLES.filter((r) => typeof r.minCount === 'number').forEach((r) => {
      if ((roleCounts[r.id] || 0) < r.minCount) {
        throw new Error(`Legalább ${r.minCount} ${r.name} kell.`);
      }
    });

    const pool = [];
    Object.entries(roleCounts).forEach(([roleId, count]) => {
      for (let i = 0; i < count; i++) pool.push(roleId);
    });
    while (pool.length < state.players.length) pool.push(fillerRoleId);
    if (pool.length > state.players.length) {
      throw new Error('Több szerep lett megadva, mint ahány játékos van.');
    }

    // Fisher-Yates shuffle
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }

    state.players.forEach((p, idx) => {
      p.roleId = pool[idx];
      p.alive = true;
      p.shieldUsed = false;
    });

    // Land on the same "Szerepek kiosztva" screen the manual flow ends on (empty
    // queue = renderAssign shows the roster + swap + "Játék indítása" right away).
    state.assignmentQueue = [];
    state.assignmentTotalCounts = { ...roleCounts };
    state.assignmentHistory = [];
    state.assignmentWasManual = false;
    state.phase = PHASES.ASSIGN;
    save();
  }

  // Undoes the most recently confirmed role and puts it back at the front of the
  // queue, so the narrator can redo it with different people. If the queue had
  // just emptied out (assignRoleToPlayers() auto-filled the leftover players as
  // fillerRoleId), that fill is its own history entry (isFillerFill) even
  // though the narrator never confirmed it - undone here too, in the SAME
  // "Vissza" tap, so those players go back to unassigned instead of staying
  // stuck holding fillerRoleId and unselectable for whatever gets reassigned.
  function stepBackAssignment() {
    if (state.phase !== PHASES.ASSIGN || state.assignmentHistory.length === 0) return;
    let last = state.assignmentHistory.pop();
    if (last.isFillerFill) {
      last.playerIds.forEach((id) => {
        const p = state.players.find((pl) => pl.id === id);
        if (p) p.roleId = null;
      });
      if (state.assignmentHistory.length === 0) { save(); return; }
      last = state.assignmentHistory.pop();
    }
    last.playerIds.forEach((id) => {
      const p = state.players.find((pl) => pl.id === id);
      if (p) p.roleId = null;
    });
    state.assignmentQueue.unshift(last.roleId);
    save();
  }

  // Swaps two already-assigned players' roles - lets the narrator fix a mistake on
  // the "Szerepek kiosztva" board without stepping all the way back. Only offered
  // after an automatic draw (see assignmentWasManual) - manual assignment has its
  // own "Vissza" undo and already announced each role as it was handed out.
  function swapPlayerRoles(idA, idB) {
    if (state.assignmentWasManual) return;
    if (idA === idB) return;
    const a = state.players.find((p) => p.id === idA);
    const b = state.players.find((p) => p.id === idB);
    if (!a || !b) return;
    const tmp = a.roleId;
    a.roleId = b.roleId;
    b.roleId = tmp;
    save();
  }

  function cancelRoleAssignment() {
    if (state.phase !== PHASES.ASSIGN) return;
    state.players.forEach((p) => { p.roleId = null; });
    state.assignmentQueue = [];
    state.assignmentTotalCounts = {};
    state.assignmentHistory = [];
    state.phase = PHASES.SETUP;
    save();
  }

  // Any role-specific pre-game info (e.g. Kőműves learning who the other Kőműves
  // are, Csonkoló learning who the gyilkosok are) is the narrator's job to share
  // right here, during "0. éjszaka" - the roster on this same screen already shows
  // everyone's role, so there's no separate app step for it.
  function startGame() {
    if (state.players.length < 3) {
      throw new Error('Legalább 3 játékos kell a kezdéshez.');
    }
    if (state.players.some((p) => !p.roleId)) {
      throw new Error('Előbb osszátok ki a szerepeket.');
    }
    state.round = 1;
    beginNight();
  }

  // ---- Night phase ----

  function beginNight() {
    // The village doesn't starve mid-day, only when it goes to sleep again -
    // state.pekHungerStreak already reached 3+ during the PREVIOUS resolveNight()
    // (see its own comment there), but that day still got to play out fully as
    // one last chance to win some other way (e.g. voting out the right person).
    // Only actually ends the game here, instead of ever starting this night.
    if (state.pekHungerStreak >= 3) {
      state.winner = 'gyilkosok';
      state.winReason = 'starvation';
      state.phase = PHASES.ENDED;
      save();
      return;
    }
    state.phase = PHASES.NIGHT;
    state.nightActions = {};
    state.abductedIds = [];
    state.pendingDeaths = [];
    state.dayEliminatedIds = [];
    // Every role assigned to someone THIS GAME keeps its nightly turn for the rest of
    // the game, even after its holder(s) die - a real narrator still calls "Gyilkosok,
    // ébredjetek" every night regardless, so skipping the call wouldn't leak who died
    // via timing. index.html's renderNight shows a "mock" turn (no one selectable,
    // just "Tovább") whenever nobody can currently act it out - see roleHasActor().
    const rolesInGame = new Set(state.players.map((p) => p.roleId));
    state.nightRoleOrder = ROLES
      .filter((r) => r.nightAction && rolesInGame.has(r.id))
      .sort((a, b) => a.nightOrder - b.nightOrder)
      .map((r) => r.id);
    state.nightCursor = 0;
    state.nightVisited = [];
    state.nightForcedSkipped = [];
    // In practice this never starts empty (Orvos/Rendőr are always in rolesInGame),
    // but resolve immediately if it ever did rather than getting stuck with nothing
    // to render.
    if (state.nightRoleOrder.length === 0) {
      resolveNight();
    } else {
      save();
    }
  }

  function currentNightRole() {
    if (state.phase !== PHASES.NIGHT || state.nightCursor >= state.nightRoleOrder.length) return null;
    return getRole(state.nightRoleOrder[state.nightCursor]);
  }

  // abductedIds is always derived fresh from nightActions, never hand-mutated -
  // whoever picked what is the only source of truth, so revisiting and changing an
  // earlier role's pick (Cupido's bond, the UFO's target) automatically keeps this
  // correct without needing separate undo bookkeeping for it.
  function computeAbductedIds() {
    const ids = [];
    const ufoAction = state.nightActions['ufo'];
    if (ufoAction && ufoAction.targetId) ids.push(ufoAction.targetId);
    const linkAction = state.nightActions['cupido'];
    if (linkAction && linkAction.pairIds) {
      const [a, b] = linkAction.pairIds;
      if (ids.includes(a) && !ids.includes(b)) ids.push(b);
      else if (ids.includes(b) && !ids.includes(a)) ids.push(a);
    }
    return ids;
  }

  // Whether roleId currently has a living, reachable holder to actually ask -
  // false once every living holder is abducted (or all of them are dead). Same
  // rule index.html's own roleHasActor() uses to decide whether to show the
  // "mock" no-actor screen. The UFO is exempt from its own abducted-ness - a
  // Cupido bond can chain-drag the UFO's own holder into state.abductedIds, but
  // that can't be what makes the UFO itself unreachable (see skipNightAction()).
  function roleHasActor(roleId) {
    return state.players.some((p) => p.roleId === roleId && p.alive && (roleId === 'ufo' || !state.abductedIds.includes(p.id)));
  }

  // A role just got a REAL pick recorded (as opposed to a forced pass-through -
  // see skipNightAction()), so any earlier "forced" flag no longer applies.
  function clearForcedSkip(roleId) {
    const idx = state.nightForcedSkipped.indexOf(roleId);
    if (idx !== -1) state.nightForcedSkipped.splice(idx, 1);
  }

  // Moves to the next role in tonight's fixed order (state.nightRoleOrder) -
  // once it runs past the last one, currentNightRole() starts returning null,
  // which index.html reads as "show the end-of-night summary" instead of
  // immediately resolving. The narrator can still jump back to fix any role's
  // pick from there (jumpToNightStep()) - only finishNight() actually resolves.
  // Never touches nightActions itself - that's entirely up to whichever
  // record*Action()/skipNightAction() call is advancing past its own role.
  //
  // Marks the role just left as visited, then moves forward by one AS USUAL -
  // except right at the boundary (would otherwise run past the last role),
  // where it first checks for any role that still needs a real look (see
  // isSettled below) instead of finishing with it silently never shown. Only
  // once every role is settled does this actually reach nightRoleOrder.length
  // (the end-of-night summary).
  //
  // Also checked BEFORE the normal step - if this confirm/skip was the very
  // last unsettled role, everything is now settled, so this goes straight back
  // to the summary instead of stepping forward one role at a time through
  // everything else that's already decided.
  function advanceNightCursor() {
    const leavingRole = currentNightRole();
    if (leavingRole && !state.nightVisited.includes(leavingRole.id)) {
      state.nightVisited.push(leavingRole.id);
    }
    const order = state.nightRoleOrder;
    // A visited role only counts as genuinely SETTLED if it wasn't a forced
    // pass-through (nightForcedSkipped - see skipNightAction()), or - even if
    // it was - it's still just as unreachable right now as it was then. If the
    // UFO's target has since moved off this role's holder, the reason it got
    // force-skipped is gone, so it needs a real look before the night can wrap
    // up, exactly like a role that was never visited at all - otherwise the
    // narrator could reach the summary (or the night could resolve) without
    // this role ever having had an actual chance to act, just because the UFO
    // happened to be pointed at it the moment its turn came up.
    const isSettled = (id) => state.nightVisited.includes(id)
      && (!state.nightForcedSkipped.includes(id) || !roleHasActor(id));
    if (order.every(isSettled)) {
      state.nightCursor = order.length;
      save();
      return;
    }
    let next = state.nightCursor + 1;
    if (next >= order.length) {
      const firstUnsettled = order.findIndex((id) => !isSettled(id));
      next = firstUnsettled === -1 ? order.length : firstUnsettled;
    }
    state.nightCursor = next;
    save();
  }

  // Just moves the "which screen is showing" pointer back one - nightActions is
  // untouched, so whatever was picked for the role landed on is still there,
  // exactly as recordXAction() left it (see currentNightRole()/renderNight()).
  function stepBackNightAction() {
    if (state.phase !== PHASES.NIGHT || state.nightCursor <= 0) return;
    state.nightCursor -= 1;
    save();
  }

  // Jumps the pointer straight to any role in tonight's order, forward or back -
  // the narrator tapping a step in the progress row (see nightProgressHtml() in
  // index.html). Same as stepBackNightAction(): only moves where we're looking,
  // never touches a single nightActions entry.
  function jumpToNightStep(roleId) {
    if (state.phase !== PHASES.NIGHT) return;
    const index = state.nightRoleOrder.indexOf(roleId);
    if (index === -1) return;
    state.nightCursor = index;
    save();
  }

  // Confirms the end-of-night summary (index.html's renderNightSummary()) -
  // only reachable once state.nightCursor has run past every role
  // (currentNightRole() === null), so there's nothing left the narrator hasn't
  // at least been shown a chance to fix. Actually resolves the night.
  function finishNight() {
    if (state.phase !== PHASES.NIGHT || state.nightCursor < state.nightRoleOrder.length) return;
    resolveNight();
  }

  function recordNightAction(targetId) {
    const role = currentNightRole();
    if (!role) return;
    state.nightActions[role.id] = { targetId };
    state.abductedIds = computeAbductedIds();
    clearForcedSkip(role.id);
    advanceNightCursor();
  }

  // Gyilkos picks state.killsPerNight targets at once (1 by default, configurable at
  // setup) - its own recorder since the generic single-target one only ever handles
  // exactly one pick. Stored as targetIds (array) instead of targetId.
  function recordKillAction(targetIds) {
    const role = currentNightRole();
    if (!role || role.id !== 'gyilkos') return;
    const capacity = killCapacity();
    const uniqueIds = [...new Set(targetIds)].filter(Boolean);
    if (uniqueIds.length !== capacity) return;
    state.nightActions[role.id] = { targetIds: uniqueIds };
    state.abductedIds = computeAbductedIds();
    clearForcedSkip(role.id);
    advanceNightCursor();
  }

  // Cupido-style actions pick two players instead of one, so they get their own recorder.
  // Cupido may link in someone the UFO already abducted - in that case the bond drags
  // the other half of the pair along too, so the UFO effectively takes both of them.
  function recordLinkAction(idA, idB) {
    const role = currentNightRole();
    if (!role || role.nightAction !== 'link') return;
    if (!idA || !idB || idA === idB) return;
    state.nightActions[role.id] = { pairIds: [idA, idB] };
    state.abductedIds = computeAbductedIds();
    clearForcedSkip(role.id);
    advanceNightCursor();
  }

  // Csonkoló's action picks a target AND a body part - the actual restriction
  // (can't vote / can't speak tomorrow) is worked out in resolveNight(), since it
  // depends on whether the target was abducted this same night.
  function recordMaimAction(targetId, bodyPart) {
    const role = currentNightRole();
    if (!role || role.nightAction !== 'maim') return;
    if (!targetId || (bodyPart !== 'kez' && bodyPart !== 'nyelv')) return;
    state.nightActions[role.id] = { targetId, bodyPart };
    state.abductedIds = computeAbductedIds();
    clearForcedSkip(role.id);
    advanceNightCursor();
  }

  // No action for this role tonight - explicitly removes any earlier pick too (e.g.
  // the narrator revisited a role and decided against what they'd picked before),
  // not just a no-op skip.
  function skipNightAction() {
    const role = currentNightRole();
    if (!role) return;
    delete state.nightActions[role.id];
    // Was there actually a living, reachable holder to ask? If so, this is a
    // real "Kihagyás" the narrator chose - if not, the mock/no-actor screen was
    // the only option, so it doesn't count as a genuine decision (see
    // nightForcedSkipped's own comment in freshState()).
    const hadActor = roleHasActor(role.id);
    const forcedIdx = state.nightForcedSkipped.indexOf(role.id);
    if (hadActor) {
      if (forcedIdx !== -1) state.nightForcedSkipped.splice(forcedIdx, 1);
    } else if (forcedIdx === -1) {
      state.nightForcedSkipped.push(role.id);
    }
    state.abductedIds = computeAbductedIds();
    advanceNightCursor();
  }

  // The playerId of whoever is bonded to playerId via tonight's Cupido link, or null.
  function bondPartnerId(playerId, linkAction) {
    if (!linkAction || !linkAction.pairIds) return null;
    const [a, b] = linkAction.pairIds;
    return playerId === a ? b : playerId === b ? a : null;
  }

  // Resolve the collected night actions: who died.
  function resolveNight() {
    const killAction = state.nightActions['gyilkos'];
    // A single-holder role (Orvos/Cupido/Csonkoló) whose own holder got abducted
    // tonight doesn't act at all - "és az ő éjszakai szerepe sem érvényesül"
    // (roles.js's UFO description) - same idea as the allGyilkosokAbducted check
    // below, just for a role with exactly one holder instead of several. The
    // recorded pick itself (state.nightActions) is left untouched - only its
    // EFFECT here is skipped, same as a Katona's shield voids a kill without
    // deleting who was targeted.
    const actorAbducted = (roleId) => {
      const holder = state.players.find((p) => p.roleId === roleId);
      return !!holder && state.abductedIds.includes(holder.id);
    };
    const protectAction = actorAbducted('orvos') ? null : state.nightActions['orvos'];
    const linkAction = actorAbducted('cupido') ? null : state.nightActions['cupido'];
    const deaths = [];

    // Gyilkos now wakes before the UFO (see ROLE_ORDER/nightOrder in roles.js), so
    // by the time the UFO abducts someone, the kill's already been picked - unlike
    // every other night role, whose turn simply doesn't happen if they're abducted
    // first (see roleHasActor() in index.html). To keep the UFO able to void the
    // kill the same way ("ha az egyetlen élő gyilkost viszi el, az nem tud ölni"),
    // check retroactively here: if every living Gyilkos got abducted tonight, the
    // kill never happened, no matter who was picked.
    const livingGyilkosok = state.players.filter((p) => p.alive && p.roleId === 'gyilkos');
    const allGyilkosokAbducted = livingGyilkosok.length > 0
      && livingGyilkosok.every((p) => state.abductedIds.includes(p.id));

    // Gyilkos can pick more than one target a night (see state.killsPerNight) -
    // each one is checked independently against the same immunity/protection/
    // abduction rules.
    const killTargetIds = (killAction && !allGyilkosokAbducted) ? (killAction.targetIds || []) : [];
    const protectedId = protectAction ? protectAction.targetId : null;
    killTargetIds.forEach((targetId) => {
      const targetPlayer = state.players.find((p) => p.id === targetId);
      const targetRole = targetPlayer ? getRole(targetPlayer.roleId) : null;
      const partnerId = bondPartnerId(targetId, linkAction);
      const partnerPlayer = partnerId ? state.players.find((p) => p.id === partnerId) : null;
      const partnerRole = partnerPlayer ? getRole(partnerPlayer.roleId) : null;
      const wasAbducted = state.abductedIds.includes(targetId);
      // The Orvos's protection bond-transfers too - protecting one half of tonight's
      // Cupido pair shields the other half from the kill as well.
      const survivesProtection = protectedId !== null
        && (targetId === protectedId || partnerId === protectedId);

      if (survivesProtection || wasAbducted) return;

      // A Katona's shield (if it hasn't already blocked something) extends to
      // whoever Cupido bonded them with tonight too, same as the Orvos's
      // protection does - blocks this ONE kill attempt and is then permanently
      // spent, whichever of the pair actually holds it, never blocking again
      // for the rest of the game (see roles.js's hasShield).
      const shieldHolder = (targetRole && targetRole.hasShield && !targetPlayer.shieldUsed) ? targetPlayer
        : (partnerRole && partnerRole.hasShield && partnerPlayer && !partnerPlayer.shieldUsed) ? partnerPlayer
        : null;
      if (shieldHolder) {
        shieldHolder.shieldUsed = true;
        state.katonaShieldLostRound = state.round;
        return;
      }

      deaths.push(targetId);
    });

    // Cupido's bond: whatever happened to one of tonight's linked pair happens
    // to the other too - if one died tonight, so does their partner.
    if (linkAction && linkAction.pairIds) {
      const [a, b] = linkAction.pairIds;
      if (deaths.includes(a) && !deaths.includes(b)) deaths.push(b);
      else if (deaths.includes(b) && !deaths.includes(a)) deaths.push(a);
    }

    state.pendingDeaths = deaths;
    deaths.forEach((id) => {
      const p = state.players.find((pl) => pl.id === id);
      if (p) {
        p.alive = false;
      }
    });

    // Csonkoló: tomorrow's speech/vote restriction(s) - void if the target was
    // abducted or the Orvos protected them (same as death), but Cupido's bond still
    // drags the partner into the same restriction, same as it does with death.
    // Always overwritten fresh - no maim tonight clears yesterday's.
    const maimAction = actorAbducted('csonkolo') ? null : state.nightActions['csonkolo'];
    const newPendingMaim = [];

    if (maimAction && maimAction.targetId) {
      const wasAbducted = state.abductedIds.includes(maimAction.targetId);
      // Same protection bond-transfer as the kill: protecting the target's Cupido
      // partner shields the target from the maim too.
      const wasProtected = !!protectAction
        && (protectAction.targetId === maimAction.targetId || bondPartnerId(maimAction.targetId, linkAction) === protectAction.targetId);

      if (!wasAbducted && !wasProtected) {
        newPendingMaim.push({ targetId: maimAction.targetId, bodyPart: maimAction.bodyPart });

        if (linkAction && linkAction.pairIds) {
          const partnerId = bondPartnerId(maimAction.targetId, linkAction);
          if (partnerId) {
            newPendingMaim.push({ targetId: partnerId, bodyPart: maimAction.bodyPart });
          }
        }
      }
    }

    state.pendingMaim = newPendingMaim;

    // One entry per round, night+day together (the day-phase deaths - a vote or
    // a Vadász's shot - get appended to THIS SAME entry later, see
    // eliminatePlayer()/resolveHunterShot()) - the ended screen's paginated
    // history reads this. Rather than separately re-deriving "who died/was
    // maimed" here, it snapshots the RAW inputs (nightActions, abductedIds, and
    // who's alive going into the day) - index.html rebuilds a fake state from
    // this and reuses its own resolveTentativeNight()/nightSummaryRowsHtml(),
    // the exact same logic that already renders tonight's summary live, so a
    // past round looks exactly like it did on the day it happened, with no
    // separate "what happened" logic to keep in sync. nightActions' own values
    // are never mutated in place after being set (only ever replaced wholesale
    // by the next record*Action() call, or wiped by the next beginNight()), so
    // a shallow copy of the dict is a safe, permanent snapshot.
    state.roundHistory.push({
      round: state.round,
      nightActions: { ...state.nightActions },
      abductedIds: [...state.abductedIds],
      aliveIds: state.players.filter((p) => p.alive).map((p) => p.id),
      dayDeaths: [], // { playerId, cause: 'vote' | 'hunter' }
    });

    // Pék: one unified streak for "consecutive rounds nobody actually got
    // bread" - abducted, dead (no living holder to even ask), or just skipped
    // while active, none of it matters why, it all resets to 0 the moment
    // bread IS given and climbs by 1 otherwise. This is what lets a Pék who
    // gives bread and THEN dies from something else that same night correctly
    // reset the streak for this round (bread really was given) instead of
    // starting the countdown early - only the FOLLOWING round, with no Pék
    // left to ask, actually begins climbing. Never moves at all if no Pék
    // exists in this game.
    const pekPlayer = state.players.find((p) => p.roleId === 'pek');
    if (pekPlayer) {
      const pekAbductedThisRound = state.abductedIds.includes(pekPlayer.id);
      const breadGivenThisRound = !pekAbductedThisRound && !!(state.nightActions['pek'] && state.nightActions['pek'].targetId);
      state.pekHungerStreak = breadGivenThisRound ? 0 : state.pekHungerStreak + 1;
    }
    // Reaching 3 doesn't end the game THIS instant - the village still gets to
    // live through the day that follows (their last chance to win some other
    // way, e.g. voting out the right person) - see beginNight()'s own check,
    // which is what actually ends it in starvation, the moment they'd go to
    // sleep again with the streak still at 3 or more.

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
      state.winReason = deriveWinReason(winner);
      state.phase = PHASES.ENDED;
    } else {
      state.phase = PHASES.DAY;
    }
    save();
  }

  // Investigate result is for the narrator's eyes only - not added to the public log.
  // An abducted target can still be picked, but the UFO put them out of reach tonight,
  // so the investigation comes back empty.
  function investigateResult(targetId) {
    const target = state.players.find((p) => p.id === targetId);
    if (!target) return null;
    if (state.abductedIds.includes(targetId)) {
      return { name: target.name, abducted: true };
    }
    const role = getRole(target.roleId);
    // Gyári munkás is tracked as its own team elsewhere (the yellow badge, its
    // spot at the end of the role order) so the narrator can tell it apart at a
    // glance, but the Rendőr's investigation still reads it as an ordinary
    // Polgár - it has no kill/maim/etc. to give it away as anything else.
    const team = role && role.id === 'gyarimunkas' ? 'polgarok' : (role ? role.team : 'ismeretlen');
    return { name: target.name, team };
  }

  // ---- Day phase ----

  // No cap on how many can be voted out in one day any more - each successful
  // call just appends to state.dayEliminatedIds (index.html shows one coffin
  // banner per entry) and leaves the day phase open for another, instead of
  // locking after the first. Only a soloWinIfVotedOut/shootsOnElimination role,
  // or the game actually ending, interrupts that.
  function eliminatePlayer(id) {
    const p = state.players.find((pl) => pl.id === id);
    if (!p || !p.alive) return;
    p.alive = false;
    state.dayEliminatedIds.push(id);
    const currentRoundHistory = state.roundHistory[state.roundHistory.length - 1];
    if (currentRoundHistory) currentRoundHistory.dayDeaths.push({ playerId: id, cause: 'vote' });
    const role = getRole(p.roleId);

    if (role && role.soloWinIfVotedOut) {
      state.winner = 'solo';
      state.winReason = 'solo';
      state.soloWinnerId = id;
      state.phase = PHASES.ENDED;
      save();
      return;
    }

    if (role && role.shootsOnElimination) {
      state.pendingHunterShot = id;
      save();
      return;
    }

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
      state.winReason = deriveWinReason(winner);
      state.phase = PHASES.ENDED;
    }
    save();
  }

  // The Vadász's revenge shot, taken right after they're voted out.
  function resolveHunterShot(targetId) {
    const shooter = state.players.find((p) => p.id === state.pendingHunterShot);
    const target = state.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return;
    target.alive = false;
    // Reuses the same day-elimination coffin reveal as a normal vote (see
    // eliminatePlayer()) - this death happens in the open, same as a vote, so
    // it gets the same white/black reveal, sequenced right after the Vadász's
    // own (index.html shows one popup at a time, most recent dayEliminatedIds
    // entry first).
    state.dayEliminatedIds.push(targetId);
    const currentRoundHistory = state.roundHistory[state.roundHistory.length - 1];
    if (currentRoundHistory) currentRoundHistory.dayDeaths.push({ playerId: targetId, cause: 'hunter' });
    state.pendingHunterShot = null;

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
      state.winReason = deriveWinReason(winner);
      state.phase = PHASES.ENDED;
    }
    save();
  }

  // Undoes the MOST RECENT eliminatePlayer()/resolveHunterShot() death and
  // reopens today's voting - the "Vissza" button, only enabled once at least
  // one death has happened today (see state.dayEliminatedIds). Only reachable
  // while still on the day screen (phase === DAY), so this never has to unwind
  // a solo win (that ends the game outright). A Vadász's own vote CAN still be
  // undone here even while their shot is pending - index.html shows their own
  // coffin popup (with the normal board, and this button, still underneath)
  // before the shot-target screen takes over - so pendingHunterShot is cleared
  // too if it's still pointing at whoever's being brought back.
  function reopenDayVote() {
    if (state.phase !== PHASES.DAY || state.dayEliminatedIds.length === 0) return;
    const id = state.dayEliminatedIds.pop();
    if (state.pendingHunterShot === id) state.pendingHunterShot = null;
    // Undo the matching entry this same death added to the round's history too
    // (see eliminatePlayer()/resolveHunterShot()) - always the LAST one, since
    // dayDeaths is only ever appended to in the same order as dayEliminatedIds.
    const currentRoundHistory = state.roundHistory[state.roundHistory.length - 1];
    if (currentRoundHistory && currentRoundHistory.dayDeaths.length > 0
      && currentRoundHistory.dayDeaths[currentRoundHistory.dayDeaths.length - 1].playerId === id) {
      currentRoundHistory.dayDeaths.pop();
    }
    const p = state.players.find((pl) => pl.id === id);
    if (p) {
      p.alive = true;
      // Nothing to undo for state.pekHungerStreak here - unlike the old
      // pekDeathRound, a day-vote death has no immediate effect on it at all;
      // it only reacts at the next resolveNight(), which will correctly see
      // the Pék alive again and able to give bread.
    }
    save();
  }

  function nextRound() {
    if (state.phase === PHASES.ENDED) return;
    state.round += 1;
    beginNight();
  }

  // ---- Win condition ----

  function checkWinCondition() {
    const alive = alivePlayers();
    const gyilkosok = alive.filter((p) => getRole(p.roleId)?.team === 'gyilkosok');
    const masok = alive.filter((p) => getRole(p.roleId)?.team !== 'gyilkosok');
    // Csonkoló is on the gyilkosok team too, but has no kill of his own - once
    // every actual Gyilkos is dead, nobody left can kill at night, so the town
    // is safe and polgárok win even if Csonkoló is still alive. He still counts
    // toward the gyilkosok team for the parity win below, though - that's about
    // the group's numbers, not who can literally still kill.
    const activeKillers = alive.filter((p) => p.roleId === 'gyilkos');

    if (activeKillers.length === 0) return 'polgarok';
    if (gyilkosok.length >= masok.length) return 'gyilkosok';
    return null;
  }

  // Which of checkWinCondition()'s two outcomes actually happened, for the ended
  // screen's explanation line - starvation and a Gyári munkás's solo win set
  // state.winReason directly at their own call sites instead, since neither goes
  // through checkWinCondition().
  function deriveWinReason(winner) {
    if (winner === 'polgarok') return 'gyilkosok_elfogytak';
    if (winner === 'gyilkosok') return 'gyilkosok_tobbsegben';
    return null;
  }

  // ---- Misc ----

  // Carries the player names and game settings (but not roles/roster changes) over
  // into the new game - it's almost always the same group playing again.
  function resetGame() {
    const previousNames = state.players.map((p) => p.name);
    const previousKillsPerNight = state.killsPerNight;
    const previousDayTimerMinutes = state.dayTimerMinutes;
    state = freshState();
    state.players = previousNames.map(newPlayer);
    state.killsPerNight = previousKillsPerNight;
    state.dayTimerMinutes = previousDayTimerMinutes;
    save();
  }

  function getState() {
    return state;
  }

  function init(changeCallback) {
    onChange = changeCallback;
    load();
    if (onChange) onChange(state);
  }

  return {
    PHASES,
    init,
    getState,
    getRole,
    alivePlayers,
    enterSetup,
    addPlayer,
    removePlayer,
    setKillsPerNight,
    killCapacity,
    setDayTimerMinutes,
    beginRoleAssignment,
    currentAssignmentRole,
    unassignedPlayers,
    assignRoleToPlayers,
    stepBackAssignment,
    swapPlayerRoles,
    autoAssignRoles,
    cancelRoleAssignment,
    startGame,
    currentNightRole,
    recordNightAction,
    recordKillAction,
    recordLinkAction,
    recordMaimAction,
    skipNightAction,
    stepBackNightAction,
    jumpToNightStep,
    finishNight,
    resolveNight,
    investigateResult,
    eliminatePlayer,
    resolveHunterShot,
    reopenDayVote,
    nextRound,
    resetGame,
  };
})();
