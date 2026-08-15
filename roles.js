// Role data. Add new custom roles here - the game engine (game.js) reads this list.
//
// Fields:
//   id            - unique identifier (lowercase, no accents)
//   name          - display name (Hungarian, shown to the narrator/players)
//   team          - 'polgarok' | 'gyilkosok' | 'semleges'
//   description   - short description for the narrator
//   nightAction   - null if the role has no night action, otherwise a string id
//                   (e.g. 'kill', 'investigate', 'protect') - game.js/index.html
//                   use this to decide what target-picker UI to show.
//                   'link' is special: it picks TWO players instead of one
//                   (see Cupido) and is handled by its own UI flow / Game function.
//                   'maim' is special: picks a target AND a body part (kéz/nyelv) in
//                   two steps (see Csonkoló) and is handled by its own UI flow.
//   nightOrder    - number giving the wake-up order during the night
//                   (lower = called earlier). null if there's no night action.
//   actionPrompt  - instruction text shown to the narrator during the role's own
//                   night action.
//   emoji         - single emoji shown next to the role's name (badges, night header,
//                   the roles-info modal). Rendering is entirely up to the device/OS -
//                   see the note in index.html where it's used.
//   maxCount      - set to 1 for roles that only ever exist once per game (the setup
//                   screen then shows an on/off toggle instead of a number stepper).
//                   Omit for roles that can have several instances (e.g. gyilkos).
//   minCount      - lowest allowed count for a plain number-input role (e.g. gyilkos
//                   must always be at least 1). The setup screen enforces this live
//                   (red warning + blocks "Szerepek kiosztása") and Game.assignRoles()
//                   enforces it again as a safety net.
//   alwaysActive  - true for roles that are simply always in the game (1 of them),
//                   with no toggle at all in the setup screen - see Nyomozó/Orvos.
//                   Mutually exclusive with maxCount/linkedCountRoleId.
//   linkedCountRoleId - set to another role's id to make the setup screen show this
//                   role's headcount as a read-only number that always mirrors that
//                   other role's count, instead of a plain number input (see Kőműves,
//                   which always matches the number of gyilkos). Combine with
//                   maxCount: 1 to also show a toggle that turns the whole group
//                   on/off (the mirrored count only counts while it's on).
//   immuneToKill  - true if the gyilkosok's night kill never works on this role
//                   (see Katona). Doesn't protect from other death causes (day vote,
//                   Cupido's bond, a Vadász's shot).
//   soloWinIfVotedOut - true if being voted out during the day immediately ends the
//                   game with this player as the sole winner (see Gyári munkás).
//   shootsOnElimination - true if being voted out during the day lets this player
//                   take one more living player down with them before the round
//                   resolves (see Vadász).
//   revealRoleOnDeath - true if dying overnight gets this role its own separate
//                   morning announcement naming the role itself - see Sarki
//                   fűszeres. Unlike the plain death banner (which only names the
//                   player), this reveals who they were.

const ROLES = [
  {
    id: 'polgar',
    name: 'Polgár',
    team: 'polgarok',
    description: 'Nincs különleges képessége. Nappal vitázik és szavaz.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    emoji: '🙂',
  },
  {
    id: 'gyilkos',
    name: 'Gyilkos',
    team: 'gyilkosok',
    description: 'Éjjel a többi gyilkossal együtt kiválaszt egy áldozatot.',
    nightAction: 'kill',
    nightOrder: 1,
    actionPrompt: 'A gyilkosok, ébredjetek fel és válasszatok áldozatot!',
    emoji: '🔪',
    minCount: 1,
  },
  {
    id: 'nyomozo',
    name: 'Nyomozó',
    team: 'polgarok',
    description: 'Éjjel megvizsgálhat egy játékost, hogy megtudja, gyilkos-e.',
    nightAction: 'investigate',
    nightOrder: 5,
    actionPrompt: 'Nyomozó, ébredj fel és mutass valakit, akit megvizsgálsz!',
    emoji: '🔍',
    alwaysActive: true,
  },
  {
    id: 'orvos',
    name: 'Orvos',
    team: 'polgarok',
    description: 'Éjjel megvédhet egy játékost a gyilkosságtól (önmagát is).',
    nightAction: 'protect',
    nightOrder: 4,
    actionPrompt: 'Orvos, ébredj fel és mutasd meg, kit védesz meg ma éjjel!',
    emoji: '🩹',
    alwaysActive: true,
  },
  {
    id: 'cupido',
    name: 'Cupido',
    team: 'polgarok',
    description: 'Éjjel összeköt két embert arra az éjszakára: ami az egyikkel történik (meghal), az a másikkal is megtörténik. Saját magát is választhatja az egyik félnek. Azt is beköthet, akit az UFO aznap éjjel elrabolt - ilyenkor a párja is az UFO áldozata lesz, így az UFO ezen az éjjelen ketten viszi el. Minden éjjel újraköthet.',
    nightAction: 'link',
    nightOrder: 3,
    actionPrompt: 'Cupido, ébredj fel és köss össze két embert ma éjjelre!',
    emoji: '💘',
    maxCount: 1,
  },
  {
    id: 'komuves',
    name: 'Kőműves',
    team: 'polgarok',
    description: 'Jó barátok, akik tudják, hogy egyikük sem gyilkos - a szerepek kiosztásakor (a "0. éjszakán") a játékvezető elárulja nekik, kik a többi kőműves. Ezután semmi különleges szerepük nincs, onnantól úgy játszanak, mint a polgárok. Mindig annyian vannak, ahány gyilkos van a játékban.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    emoji: '⚒️',
    linkedCountRoleId: 'gyilkos',
    maxCount: 1,
  },
  {
    id: 'csonkolo',
    name: 'Csonkoló',
    team: 'gyilkosok',
    description: 'A gyilkosok oldalán áll, és ismeri őket (a szerepek kiosztásakor a játékvezető elárulja neki, kik ők), de a gyilkosok nem ismerik őt. Éjszakánként megcsonkíthatja valaki kezét vagy nyelvét: az illető a következő nappal nem szavazhat (kéz) vagy nem beszélhet (nyelv). Ha az UFO elrabolta a célpontját aznap éjjel, vagy az Orvos épp őt védte, a csonkítás nem érvényesül. Ha a célpont aznap éjjel Cupido kötésében volt, a párja is ugyanúgy megcsonkul.',
    nightAction: 'maim',
    nightOrder: 6,
    actionPrompt: 'Csonkoló, ébredj fel és válaszd ki, kit csonkítasz meg ma éjjel!',
    emoji: '🪚',
    maxCount: 1,
  },
  {
    id: 'ufo',
    name: 'UFO',
    team: 'polgarok',
    description: 'Éjjel elrabol valakit: azon az éjszakán nem célozható, és ha éjszakai szerepe van, az nem érvényesül (pl. ha az egyetlen élő gyilkost viszi el, az nem tud ölni). Saját magát nem viheti el. Másnap nappal és a következő éjjel már minden normális.',
    nightAction: 'abduct',
    nightOrder: 2,
    actionPrompt: 'UFO, ébredj fel és mutasd meg, kit rabolsz el ma éjjel!',
    emoji: '🛸',
    maxCount: 1,
  },
  {
    id: 'gyarimunkas',
    name: 'Gyári munkás',
    team: 'semleges',
    description: 'Célja, hogy nappal kiszavazzák - ha ez sikerül, egyedül ő nyer, és a játéknak azonnal vége. Ha éjjel ölik meg, nem éri el a célját, és a játék normálisan folytatódik. Nincs feladata éjszaka.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    emoji: '🧰',
    maxCount: 1,
    soloWinIfVotedOut: true,
  },
  {
    id: 'katona',
    name: 'Katona',
    team: 'polgarok',
    description: 'Éjjel a gyilkosok nem tudják megölni, hiába próbálkoznak - a merénylet mindig kudarcot vall. Nincs feladata éjszaka.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    emoji: '🛡️',
    maxCount: 1,
    immuneToKill: true,
  },
  {
    id: 'vadasz',
    name: 'Vadász',
    team: 'polgarok',
    description: 'Ha nappal kiszavazzák, lelő valakit, aki vele együtt meghal (a narrátor a kiszavazás után választja ki a célpontot). Ha éjjel ölik meg, nem tud lőni. Nincs feladata éjszaka.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    emoji: '🏹',
    maxCount: 1,
    shootsOnElimination: true,
  },
  {
    id: 'fuszeres',
    name: 'Sarki fűszeres',
    team: 'polgarok',
    description: 'Nincs feladata. Csak egy hétköznapi lakos a boltjával. Ha meghal, a narrátor bejelenti, hogy ő volt a Sarki fűszeres.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    emoji: '🍃',
    maxCount: 1,
    revealRoleOnDeath: true,
  },
  {
    id: 'pek',
    name: 'Pék',
    team: 'polgarok',
    description: 'Éjszakánként pékárut ad valakinek - ennek önmagában nincs hatása, a narrátor csak minden reggel bejelenti, ki kapott kenyeret. Ha a Pék meghal, 3 éjszakával később éhen hal a város és a gyilkosok győznek, ha addig másképp nem dőlt el a játék. Ugyanez történik akkor is, ha az UFO három egymást követő éjszakán elrabolja.',
    nightAction: 'gift',
    nightOrder: 7,
    actionPrompt: 'Pék, ébredj fel és add oda a pékárut valakinek!',
    emoji: '🥖',
    maxCount: 1,
  },
  {
    id: 'polgarmester',
    name: 'Polgármester',
    team: 'polgarok',
    description: 'Nappal 2 szavazata van (ezt a csoport kézfelemeléssel/szavazással kezeli, az app nem számolja a szavazatokat). A kiléte mindenki számára ismert a játék elejétől fogva. Nincs feladata éjszaka.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    emoji: '⭐',
    maxCount: 1,
  },
];

// Canonical role order, shared by everything that lists every role in a fixed
// reading order: the setup screen falls back to this for anything missing from
// its own SETUP_ROLE_ORDER (index.html), the post-assignment roster/night
// summary/ended screen (index.html's ROLE_SORT_ORDER), and game.js's manual
// "0. éjszaka" assignment queue (beginRoleAssignment) - so roles get asked for
// in the same order they're later displayed in. Polgár is never actually queued
// for assignment (it's always the leftover filler), so its position here only
// matters for the display-only consumers.
const ROLE_ORDER = [
  'gyilkos', 'csonkolo', 'nyomozo', 'orvos', 'ufo', 'cupido', 'komuves',
  'vadasz', 'katona', 'pek', 'fuszeres', 'polgarmester', 'polgar', 'gyarimunkas',
];
