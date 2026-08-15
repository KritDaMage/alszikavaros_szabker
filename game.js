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
    REVEAL: 'reveal',
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
      pendingReveals: [], // roleIds still needing their once-only "meet each other" moment
                          // (see PHASES.REVEAL) - shown right before round 1, not during it
      nightQueue: [], // roleIds in order, still waiting to act this night
      nightActions: {}, // roleId -> { targetId }
      nightActionHistory: [], // snapshots taken before each recorded/skipped night
                               // action, for the "Vissza" button - see stepBackNightAction()
      abductedIds: [], // playerIds untouchable this night - the UFO's target, plus anyone
                        // Cupido links to an already-abducted player (chain reaction).
                        // Can't be targeted, and their own night action (if any) is voided,
                        // for this night only.
      pendingDeaths: [], // result of the current night's resolution, until announced
      dayVoteResolved: false, // true once the day's one allowed elimination decision has
                               // been made (eliminatePlayer or noElimination) - blocks
                               // voting again until beginNight() resets it for next round
      pendingHunterShot: null, // playerId of a just-eliminated Vadász, waiting for their shot target
      pendingMaim: [], // [{ targetId, bodyPart: 'kez' | 'nyelv' }] - Csonkoló's victim(s) for
                        // the upcoming day only (2 if Cupido's bond dragged in a partner).
                        // Overwritten fresh every resolveNight().
      pekDeathRound: null, // round the Pék died in, or null - starts the starvation countdown
      pekConsecutiveAbductions: 0, // nights in a row the UFO has taken the Pék
      winner: null, // null | 'polgarok' | 'gyilkosok' | 'solo'
      soloWinnerId: null, // playerId, only set when winner === 'solo' (e.g. Gyári munkás)
    };
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
      state = raw ? JSON.parse(raw) : freshState();
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
  // queue holds each DISTINCT role once (in nightOrder, no-night-action roles last);
  // roles with more than one slot (e.g. 2 gyilkos) are filled all at once from a
  // single screen instead of one-at-a-time. Whoever is left once the queue is empty
  // becomes fillerRoleId.
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
      .sort((a, b) => (a.nightOrder ?? Infinity) - (b.nightOrder ?? Infinity))
      .map((r) => r.id);

    const totalSlots = distinctRoles.reduce((sum, id) => sum + (roleCounts[id] || 0), 0);
    if (totalSlots > state.players.length) {
      throw new Error('Több szerep lett megadva, mint ahány játékos van.');
    }

    state.players.forEach((p) => { p.roleId = null; p.alive = true; });
    state.assignmentQueue = distinctRoles;
    state.assignmentTotalCounts = { ...roleCounts };
    state.assignmentHistory = [];
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
      state.players.forEach((p) => { if (!p.roleId) p.roleId = fillerRoleId; });
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
    });

    // Land on the same "Szerepek kiosztva" screen the manual flow ends on (empty
    // queue = renderAssign shows the roster + swap + "Játék indítása" right away).
    state.assignmentQueue = [];
    state.assignmentTotalCounts = { ...roleCounts };
    state.assignmentHistory = [];
    state.phase = PHASES.ASSIGN;
    save();
  }

  // Undoes the most recently confirmed role and puts it back at the front of the
  // queue, so the narrator can redo it with different people.
  function stepBackAssignment() {
    if (state.phase !== PHASES.ASSIGN || state.assignmentHistory.length === 0) return;
    const last = state.assignmentHistory.pop();
    last.playerIds.forEach((id) => {
      const p = state.players.find((pl) => pl.id === id);
      if (p) p.roleId = null;
    });
    state.assignmentQueue.unshift(last.roleId);
    save();
  }

  // Swaps two already-assigned players' roles - lets the narrator fix a mistake on
  // the "Szerepek kiosztva" board without stepping all the way back.
  function swapPlayerRoles(idA, idB) {
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

  function startGame() {
    if (state.players.length < 3) {
      throw new Error('Legalább 3 játékos kell a kezdéshez.');
    }
    if (state.players.some((p) => !p.roleId)) {
      throw new Error('Előbb osszátok ki a szerepeket.');
    }

    // preGameReveal roles (e.g. Kőműves, Csonkoló) get their moment here, during
    // "0. éjszaka", regardless of whether roles were assigned manually or
    // automatically - not folded into round 1's night queue.
    const revealRoles = ROLES
      .filter((r) => r.preGameReveal)
      .filter((r) => alivePlayers().some((p) => p.roleId === r.id))
      .sort((a, b) => (a.nightOrder ?? Infinity) - (b.nightOrder ?? Infinity))
      .map((r) => r.id);

    if (revealRoles.length > 0) {
      state.pendingReveals = revealRoles;
      state.phase = PHASES.REVEAL;
    } else {
      state.round = 1;
      beginNight();
    }
    save();
  }

  function currentPreGameReveal() {
    if (state.phase !== PHASES.REVEAL || state.pendingReveals.length === 0) return null;
    return getRole(state.pendingReveals[0]);
  }

  function acknowledgePreGameReveal() {
    const role = currentPreGameReveal();
    if (!role) return;
    state.pendingReveals.shift();

    if (state.pendingReveals.length === 0) {
      state.round = 1;
      beginNight();
    }
    save();
  }

  // ---- Night phase ----

  function beginNight() {
    state.phase = PHASES.NIGHT;
    state.nightActions = {};
    state.nightActionHistory = [];
    state.abductedIds = [];
    state.pendingDeaths = [];
    state.dayVoteResolved = false;
    // Every role assigned to someone THIS GAME keeps its nightly turn for the rest of
    // the game, even after its holder(s) die - a real narrator still calls "Gyilkosok,
    // ébredjetek" every night regardless, so skipping the call wouldn't leak who died
    // via timing. index.html's renderNight shows a "mock" turn (no one selectable,
    // just "Tovább") whenever nobody can currently act it out - see roleHasActor().
    const rolesInGame = new Set(state.players.map((p) => p.roleId));
    // onceOnly roles never appear in a regular night's queue - they got their
    // moment pre-game, in PHASES.REVEAL (see startGame()).
    state.nightQueue = ROLES
      .filter((r) => r.nightAction && rolesInGame.has(r.id) && !r.onceOnly)
      .sort((a, b) => a.nightOrder - b.nightOrder)
      .map((r) => r.id);
    save();
  }

  function currentNightRole() {
    if (state.phase !== PHASES.NIGHT || state.nightQueue.length === 0) return null;
    return getRole(state.nightQueue[0]);
  }

  // Snapshot taken right before a role's action is recorded or skipped, so
  // stepBackNightAction() can restore everything that action touched (the queue,
  // the recorded action, abductions) without having to manually reverse each role's
  // specific logic.
  function snapshotNightState(roleId) {
    return {
      roleId,
      nightQueue: [...state.nightQueue],
      nightActions: JSON.parse(JSON.stringify(state.nightActions)),
      abductedIds: [...state.abductedIds],
    };
  }

  function stepBackNightAction() {
    if (state.phase !== PHASES.NIGHT || state.nightActionHistory.length === 0) return;
    const last = state.nightActionHistory.pop();
    state.nightQueue = last.nightQueue;
    state.nightActions = last.nightActions;
    state.abductedIds = last.abductedIds;
    save();
  }

  function recordNightAction(targetId) {
    const role = currentNightRole();
    if (!role) return;
    state.nightActionHistory.push(snapshotNightState(role.id));
    state.nightActions[role.id] = { targetId };
    state.nightQueue.shift();

    if (role.id === 'ufo') {
      state.abductedIds.push(targetId);
    }

    save();
  }

  // Cupido-style actions pick two players instead of one, so they get their own recorder.
  // Cupido may link in someone the UFO already abducted - in that case the bond drags
  // the other half of the pair along too, so the UFO effectively takes both of them.
  function recordLinkAction(idA, idB) {
    const role = currentNightRole();
    if (!role || role.nightAction !== 'link') return;
    if (!idA || !idB || idA === idB) return;
    state.nightActionHistory.push(snapshotNightState(role.id));
    state.nightActions[role.id] = { pairIds: [idA, idB] };
    state.nightQueue.shift();

    if (state.abductedIds.includes(idA) && !state.abductedIds.includes(idB)) {
      state.abductedIds.push(idB);
    } else if (state.abductedIds.includes(idB) && !state.abductedIds.includes(idA)) {
      state.abductedIds.push(idA);
    }

    save();
  }

  // Csonkoló's action picks a target AND a body part - the actual restriction
  // (can't vote / can't speak tomorrow) is worked out in resolveNight(), since it
  // depends on whether the target was abducted this same night.
  function recordMaimAction(targetId, bodyPart) {
    const role = currentNightRole();
    if (!role || role.nightAction !== 'maim') return;
    if (!targetId || (bodyPart !== 'kez' && bodyPart !== 'nyelv')) return;
    state.nightActionHistory.push(snapshotNightState(role.id));
    state.nightActions[role.id] = { targetId, bodyPart };
    state.nightQueue.shift();
    save();
  }

  function skipNightAction() {
    const role = currentNightRole();
    if (!role) return;
    state.nightActionHistory.push(snapshotNightState(role.id));
    state.nightQueue.shift();
    save();
  }

  // The playerId of whoever is bonded to playerId via tonight's Cupido link, or null.
  function bondPartnerId(playerId, linkAction) {
    if (!linkAction || !linkAction.pairIds) return null;
    const [a, b] = linkAction.pairIds;
    return playerId === a ? b : playerId === b ? a : null;
  }

  // The role of whoever is bonded to playerId via tonight's Cupido link, or null.
  function bondPartnerRole(playerId, linkAction) {
    const partnerId = bondPartnerId(playerId, linkAction);
    if (!partnerId) return null;
    const partner = state.players.find((p) => p.id === partnerId);
    return partner ? getRole(partner.roleId) : null;
  }

  // Side effects triggered by a specific player's death, wherever it happens (night
  // kill, day vote, a Vadász's shot).
  function applyDeathConsequences(player) {
    if (!player) return;
    const role = getRole(player.roleId);
    if (role && role.id === 'pek' && state.pekDeathRound === null) {
      state.pekDeathRound = state.round;
    }
  }

  // Resolve the collected night actions: who died.
  function resolveNight() {
    const killAction = state.nightActions['gyilkos'];
    const protectAction = state.nightActions['orvos'];
    const linkAction = state.nightActions['cupido'];
    const deaths = [];

    if (killAction && killAction.targetId) {
      const protectedId = protectAction ? protectAction.targetId : null;
      const targetPlayer = state.players.find((p) => p.id === killAction.targetId);
      const targetRole = targetPlayer ? getRole(targetPlayer.roleId) : null;
      // A Katona's immunity extends to whoever Cupido bonded them with tonight.
      const partnerRole = bondPartnerRole(killAction.targetId, linkAction);
      const roleImmune = (targetRole && targetRole.immuneToKill) || (partnerRole && partnerRole.immuneToKill);
      const wasAbducted = state.abductedIds.includes(killAction.targetId);
      // The Orvos's protection bond-transfers too - protecting one half of tonight's
      // Cupido pair shields the other half from the kill as well.
      const survivesProtection = protectedId !== null
        && (killAction.targetId === protectedId || bondPartnerId(killAction.targetId, linkAction) === protectedId);

      if (!survivesProtection && !roleImmune && !wasAbducted) {
        deaths.push(killAction.targetId);
      }
    }

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
        applyDeathConsequences(p);
      }
    });

    // Csonkoló: tomorrow's speech/vote restriction(s) - void if the target was
    // abducted or the Orvos protected them (same as death), but Cupido's bond still
    // drags the partner into the same restriction, same as it does with death.
    // Always overwritten fresh - no maim tonight clears yesterday's.
    const maimAction = state.nightActions['csonkolo'];
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

    // Pék: track consecutive UFO abductions while he's still alive.
    const pekPlayer = state.players.find((p) => p.roleId === 'pek');
    if (pekPlayer && pekPlayer.alive) {
      if (state.abductedIds.includes(pekPlayer.id)) {
        state.pekConsecutiveAbductions += 1;
      } else {
        state.pekConsecutiveAbductions = 0;
      }
    }

    const starvation = (state.pekDeathRound !== null && state.round - state.pekDeathRound >= 3)
      || state.pekConsecutiveAbductions >= 3;

    if (starvation) {
      state.winner = 'gyilkosok';
      state.phase = PHASES.ENDED;
      save();
      return;
    }

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
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
    return { name: target.name, team: role ? role.team : 'ismeretlen' };
  }

  // ---- Day phase ----

  function eliminatePlayer(id) {
    const p = state.players.find((pl) => pl.id === id);
    if (!p || !p.alive) return;
    p.alive = false;
    state.dayVoteResolved = true;
    const role = getRole(p.roleId);
    applyDeathConsequences(p);

    if (role && role.soloWinIfVotedOut) {
      state.winner = 'solo';
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
    applyDeathConsequences(target);
    state.pendingHunterShot = null;

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
      state.phase = PHASES.ENDED;
    }
    save();
  }

  function noElimination() {
    state.dayVoteResolved = true;
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

    if (gyilkosok.length === 0) return 'polgarok';
    if (gyilkosok.length >= masok.length) return 'gyilkosok';
    return null;
  }

  // ---- Misc ----

  // Carries the player names (but not roles/roster changes) over into the new game -
  // it's almost always the same group playing again.
  function resetGame() {
    const previousNames = state.players.map((p) => p.name);
    state = freshState();
    state.players = previousNames.map(newPlayer);
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
    beginRoleAssignment,
    currentAssignmentRole,
    unassignedPlayers,
    assignRoleToPlayers,
    stepBackAssignment,
    swapPlayerRoles,
    autoAssignRoles,
    cancelRoleAssignment,
    startGame,
    currentPreGameReveal,
    acknowledgePreGameReveal,
    currentNightRole,
    recordNightAction,
    recordLinkAction,
    recordMaimAction,
    skipNightAction,
    stepBackNightAction,
    resolveNight,
    investigateResult,
    eliminatePlayer,
    resolveHunterShot,
    noElimination,
    nextRound,
    resetGame,
  };
})();
