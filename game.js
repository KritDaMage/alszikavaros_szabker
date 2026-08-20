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
                       // now. Purely a "where are we looking" pointer: stepping back,
                       // jumping to any step (jumpToNightStep), confirming, or skipping
                       // only ever move this - none of them touch nightActions for any
                       // role other than the one currently at this position, so revisiting
                       // an earlier step can never lose a later one's pick.
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
      dayVoteResolved: false, // true once the day's one allowed elimination decision has
                               // been made (eliminatePlayer or noElimination) - blocks
                               // voting again until beginNight() resets it for next round
      dayEliminatedId: null, // playerId eliminatePlayer() just killed this vote, or null if
                              // noElimination() was picked instead - lets reopenDayVote()'s
                              // "Vissza" revive them and reopen voting
      pendingHunterShot: null, // playerId of a just-eliminated Vadász, waiting for their shot target
      pendingMaim: [], // [{ targetId, bodyPart: 'kez' | 'nyelv' }] - Csonkoló's victim(s) for
                        // the upcoming day only (2 if Cupido's bond dragged in a partner).
                        // Overwritten fresh every resolveNight().
      pekDeathRound: null, // round the Pék died in, or null - starts the starvation countdown
      pekConsecutiveAbductions: 0, // nights in a row the UFO has taken the Pék
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

    state.players.forEach((p) => { p.roleId = null; p.alive = true; });
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
    state.assignmentWasManual = false;
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
    state.phase = PHASES.NIGHT;
    state.nightActions = {};
    state.abductedIds = [];
    state.pendingDeaths = [];
    state.dayVoteResolved = false;
    state.dayEliminatedId = null;
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

  // Moves to the next role in tonight's fixed order (state.nightRoleOrder) -
  // resolves the night once it runs past the last one, instead of waiting for a
  // separate "Éjszaka lezárása" confirmation screen. Never touches nightActions
  // itself - that's entirely up to whichever record*Action()/skipNightAction()
  // call is advancing past its own role.
  function advanceNightCursor() {
    state.nightCursor += 1;
    if (state.nightCursor >= state.nightRoleOrder.length) {
      resolveNight();
    } else {
      save();
    }
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

  function recordNightAction(targetId) {
    const role = currentNightRole();
    if (!role) return;
    state.nightActions[role.id] = { targetId };
    state.abductedIds = computeAbductedIds();
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
    advanceNightCursor();
  }

  // No action for this role tonight - explicitly removes any earlier pick too (e.g.
  // the narrator revisited a role and decided against what they'd picked before),
  // not just a no-op skip.
  function skipNightAction() {
    const role = currentNightRole();
    if (!role) return;
    delete state.nightActions[role.id];
    state.abductedIds = computeAbductedIds();
    advanceNightCursor();
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
      // A Katona's immunity extends to whoever Cupido bonded them with tonight.
      const partnerRole = bondPartnerRole(targetId, linkAction);
      const roleImmune = (targetRole && targetRole.immuneToKill) || (partnerRole && partnerRole.immuneToKill);
      const wasAbducted = state.abductedIds.includes(targetId);
      // The Orvos's protection bond-transfers too - protecting one half of tonight's
      // Cupido pair shields the other half from the kill as well.
      const survivesProtection = protectedId !== null
        && (targetId === protectedId || bondPartnerId(targetId, linkAction) === protectedId);

      if (!survivesProtection && !roleImmune && !wasAbducted) {
        deaths.push(targetId);
      }
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
      state.winReason = 'starvation';
      state.phase = PHASES.ENDED;
      save();
      return;
    }

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

  function eliminatePlayer(id) {
    const p = state.players.find((pl) => pl.id === id);
    if (!p || !p.alive) return;
    p.alive = false;
    state.dayVoteResolved = true;
    state.dayEliminatedId = id;
    const role = getRole(p.roleId);
    applyDeathConsequences(p);

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
    applyDeathConsequences(target);
    state.pendingHunterShot = null;

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
      state.winReason = deriveWinReason(winner);
      state.phase = PHASES.ENDED;
    }
    save();
  }

  function noElimination() {
    state.dayVoteResolved = true;
    save();
  }

  // Undoes eliminatePlayer()/noElimination() and reopens today's vote - the
  // "Vissza" button on the locked-vote screen. Only reachable while still on the
  // day screen (phase === DAY), so this never has to unwind a solo win or a
  // Vadász's shot: both of those move the phase away from DAY (to ENDED, or to
  // the pendingHunterShot screen) before the narrator could ever see this button.
  function reopenDayVote() {
    if (state.phase !== PHASES.DAY || !state.dayVoteResolved) return;
    if (state.dayEliminatedId) {
      const p = state.players.find((pl) => pl.id === state.dayEliminatedId);
      if (p) {
        p.alive = true;
        const role = getRole(p.roleId);
        // Only undo the starvation countdown if THIS vote is what started it.
        if (role && role.id === 'pek' && state.pekDeathRound === state.round) {
          state.pekDeathRound = null;
        }
      }
      state.dayEliminatedId = null;
    }
    state.dayVoteResolved = false;
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
    resolveNight,
    investigateResult,
    eliminatePlayer,
    resolveHunterShot,
    noElimination,
    reopenDayVote,
    nextRound,
    resetGame,
  };
})();
