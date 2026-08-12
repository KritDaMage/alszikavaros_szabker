// Game engine: state management, phase transitions, event log.
// Does not touch the DOM - the <script> block in index.html calls the Game.* functions
// and gets notified via the Game.onChange callback whenever the UI needs to re-render.
// Assumes roles.js is already loaded (global ROLES variable).

const Game = (() => {
  const STORAGE_KEY = 'alszikavaros_szabker_state_v1';

  const PHASES = {
    HOME: 'home',
    SETUP: 'setup',
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
      nightQueue: [], // roleIds in order, still waiting to act this night
      nightActions: {}, // roleId -> { targetId }
      abductedIds: [], // playerIds untouchable this night - the UFO's target, plus anyone
                        // Cupido links to an already-abducted player (chain reaction).
                        // Can't be targeted, and their own night action (if any) is voided,
                        // for this night only.
      pendingDeaths: [], // result of the current night's resolution, until announced
      pendingHunterShot: null, // playerId of a just-eliminated Vadász, waiting for their shot target
      pekDeathRound: null, // round the Pék died in, or null - starts the starvation countdown
      pekConsecutiveAbductions: 0, // nights in a row the UFO has taken the Pék
      log: [], // { round, phase, text, time }
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

  function addLog(text) {
    state.log.unshift({
      round: state.round,
      phase: state.phase,
      text,
      time: new Date().toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' }),
    });
  }

  // ---- Home phase ----

  function enterSetup() {
    if (state.phase !== PHASES.HOME) return;
    state.phase = PHASES.SETUP;
    save();
  }

  // ---- Setup phase ----

  function addPlayer(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    state.players.push({
      id: 'p' + Date.now() + Math.random().toString(36).slice(2, 7),
      name: trimmed,
      roleId: null,
      alive: true,
    });
    save();
  }

  function removePlayer(id) {
    state.players = state.players.filter((p) => p.id !== id);
    save();
  }

  // roleCounts: { roleId: count } - any roles not listed (typically 'polgar')
  // fill the remaining players.
  function assignRoles(roleCounts, fillerRoleId = 'polgar') {
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

    addLog(`Szerepek kiosztva ${state.players.length} játékos között.`);
    save();
  }

  function startGame() {
    if (state.players.length < 3) {
      throw new Error('Legalább 3 játékos kell a kezdéshez.');
    }
    if (state.players.some((p) => !p.roleId)) {
      throw new Error('Előbb osszátok ki a szerepeket.');
    }
    state.round = 1;
    addLog('A játék elkezdődött.');
    beginNight();
  }

  // ---- Night phase ----

  function beginNight() {
    state.phase = PHASES.NIGHT;
    state.nightActions = {};
    state.abductedIds = [];
    state.pendingDeaths = [];
    const rolesAlive = new Set(alivePlayers().map((p) => p.roleId));
    state.nightQueue = ROLES
      .filter((r) => r.nightAction && rolesAlive.has(r.id) && (!r.onceOnly || state.round === 1))
      .sort((a, b) => a.nightOrder - b.nightOrder)
      .map((r) => r.id);
    addLog(`${state.round}. éjszaka kezdődik.`);
    save();
  }

  function currentNightRole() {
    if (state.phase !== PHASES.NIGHT || state.nightQueue.length === 0) return null;
    return getRole(state.nightQueue[0]);
  }

  // Players who may currently be picked as a night-action target: everyone alive,
  // except whoever is untouchable this night (the UFO's target, or someone Cupido
  // chain-linked to them). Cupido itself is exempt from this - see recordLinkAction.
  function nightTargetablePlayers() {
    return alivePlayers().filter((p) => !state.abductedIds.includes(p.id));
  }

  // Drops any still-pending role from the queue if every one of its living holders is
  // now untouchable (abducted or chain-linked to an abductee) - they have no one left
  // to act with tonight.
  function purgeUnactionableRoles() {
    state.nightQueue = state.nightQueue.filter((roleId) => {
      const holders = alivePlayers().filter((p) => p.roleId === roleId);
      const allUntouchable = holders.length > 0 && holders.every((p) => state.abductedIds.includes(p.id));
      if (allUntouchable) {
        addLog(`${getRole(roleId).name}: az elrablás miatt nem tud cselekedni ma éjjel.`);
      }
      return !allUntouchable;
    });
  }

  function recordNightAction(targetId) {
    const role = currentNightRole();
    if (!role) return;
    state.nightActions[role.id] = { targetId };
    addLog(`${role.name}: cél kiválasztva.`);
    state.nightQueue.shift();

    if (role.id === 'ufo') {
      state.abductedIds.push(targetId);
      purgeUnactionableRoles();
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
    state.nightActions[role.id] = { pairIds: [idA, idB] };
    const a = state.players.find((p) => p.id === idA);
    const b = state.players.find((p) => p.id === idB);
    addLog(`${role.name}: ${a ? a.name : '?'} és ${b ? b.name : '?'} összekötve ma éjjelre.`);
    state.nightQueue.shift();

    if (state.abductedIds.includes(idA) && !state.abductedIds.includes(idB)) {
      state.abductedIds.push(idB);
      addLog(`${b ? b.name : '?'} a kötés miatt szintén az UFO áldozata lett ma éjjel.`);
    } else if (state.abductedIds.includes(idB) && !state.abductedIds.includes(idA)) {
      state.abductedIds.push(idA);
      addLog(`${a ? a.name : '?'} a kötés miatt szintén az UFO áldozata lett ma éjjel.`);
    }
    purgeUnactionableRoles();

    save();
  }

  // For 'reveal' roles (e.g. Kőműves): no target to pick, the narrator just confirms
  // the role's action happened and moves on.
  function acknowledgeReveal() {
    const role = currentNightRole();
    if (!role || role.nightAction !== 'reveal') return;
    addLog(`${role.name}: megismerték egymást.`);
    state.nightQueue.shift();
    save();
  }

  function skipNightAction() {
    const role = currentNightRole();
    if (!role) return;
    addLog(`${role.name}: kihagyva.`);
    state.nightQueue.shift();
    save();
  }

  // The role of whoever is bonded to playerId via tonight's Cupido link, or null.
  function bondPartnerRole(playerId, linkAction) {
    if (!linkAction || !linkAction.pairIds) return null;
    const [a, b] = linkAction.pairIds;
    const partnerId = playerId === a ? b : playerId === b ? a : null;
    if (!partnerId) return null;
    const partner = state.players.find((p) => p.id === partnerId);
    return partner ? getRole(partner.roleId) : null;
  }

  // Side effects triggered by a specific player's death, wherever it happens (night
  // kill, day vote, a Vadász's shot). Returns a suffix to append to the death's log line.
  function applyDeathConsequences(player) {
    if (!player) return '';
    let suffix = '';
    const role = getRole(player.roleId);
    if (role && role.announceRoleOnDeath) {
      suffix += ` Bejelentés: ő volt a(z) ${role.name}!`;
    }
    if (role && role.id === 'pek' && state.pekDeathRound === null) {
      state.pekDeathRound = state.round;
      suffix += ' Nincs többé, aki kenyeret süssön - ha 3 éjszakán belül nem dől el a játék, éhen hal a város.';
    }
    return suffix;
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
      const immune = (targetRole && targetRole.immuneToKill) || (partnerRole && partnerRole.immuneToKill);
      if (killAction.targetId !== protectedId && !immune) {
        deaths.push(killAction.targetId);
      } else if (immune) {
        addLog(`${targetPlayer ? targetPlayer.name : '?'}: a gyilkosok megpróbálták megölni, de túlélte (Katona hatása).`);
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
      if (p) p.alive = false;
    });

    if (deaths.length === 0) {
      addLog('Az éjszaka mindenki túlélte.');
    } else {
      deaths.forEach((id) => {
        const p = state.players.find((pl) => pl.id === id);
        const suffix = applyDeathConsequences(p);
        addLog(`${p ? p.name : '?'} meghalt az éjszaka.${suffix}`);
      });
    }

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
      addLog('Éhen halt a város - nem maradt, aki kenyeret süssön. A gyilkosok győztek!');
      save();
      return;
    }

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
      state.phase = PHASES.ENDED;
      addLog(winner === 'polgarok' ? 'A polgárok győztek!' : 'A gyilkosok győztek!');
    } else {
      state.phase = PHASES.DAY;
    }
    save();
  }

  // Investigate result is for the narrator's eyes only - not added to the public log.
  function investigateResult(targetId) {
    const target = state.players.find((p) => p.id === targetId);
    if (!target) return null;
    const role = getRole(target.roleId);
    return { name: target.name, team: role ? role.team : 'ismeretlen' };
  }

  // ---- Day phase ----

  function eliminatePlayer(id) {
    const p = state.players.find((pl) => pl.id === id);
    if (!p || !p.alive) return;
    p.alive = false;
    const role = getRole(p.roleId);
    const suffix = applyDeathConsequences(p);
    addLog(`${p.name}-t kiszavazták.${suffix}`);

    if (role && role.soloWinIfVotedOut) {
      state.winner = 'solo';
      state.soloWinnerId = id;
      state.phase = PHASES.ENDED;
      addLog(`${p.name} (${role.name}) egyedül győzött, mert kiszavazták!`);
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
      addLog(winner === 'polgarok' ? 'A polgárok győztek!' : 'A gyilkosok győztek!');
    }
    save();
  }

  // The Vadász's revenge shot, taken right after they're voted out.
  function resolveHunterShot(targetId) {
    const shooter = state.players.find((p) => p.id === state.pendingHunterShot);
    const target = state.players.find((p) => p.id === targetId);
    if (!target || !target.alive) return;
    target.alive = false;
    const suffix = applyDeathConsequences(target);
    addLog(`${shooter ? shooter.name : 'A vadász'} lelőtte ${target.name}-t.${suffix}`);
    state.pendingHunterShot = null;

    const winner = checkWinCondition();
    if (winner) {
      state.winner = winner;
      state.phase = PHASES.ENDED;
      addLog(winner === 'polgarok' ? 'A polgárok győztek!' : 'A gyilkosok győztek!');
    }
    save();
  }

  function noElimination() {
    addLog('Nem szavaztak ki senkit.');
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

  function resetGame() {
    state = freshState();
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
    nightTargetablePlayers,
    enterSetup,
    addPlayer,
    removePlayer,
    assignRoles,
    startGame,
    currentNightRole,
    recordNightAction,
    recordLinkAction,
    acknowledgeReveal,
    skipNightAction,
    resolveNight,
    investigateResult,
    eliminatePlayer,
    resolveHunterShot,
    noElimination,
    nextRound,
    resetGame,
  };
})();
