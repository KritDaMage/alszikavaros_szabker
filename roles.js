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
//                   'reveal' is special: no target is picked at all - the narrator just
//                   reads the prompt and taps through (see Kőműves).
//   nightOrder    - number giving the wake-up order during the night
//                   (lower = called earlier). null if there's no night action.
//   actionPrompt  - instruction text shown to the narrator during the night phase
//   icon          - inner SVG markup (paths/shapes only, no <svg> wrapper) drawn on a
//                   0-24 / 0-24 viewBox, stroke-based, using currentColor so it inherits
//                   the surrounding team color. index.html wraps this in an <svg> tag.
//   maxCount      - set to 1 for roles that only ever exist once per game (the setup
//                   screen then shows an on/off toggle instead of a number stepper).
//                   Omit for roles that can have several instances (e.g. gyilkos).
//   onceOnly      - set to true for roles whose night action only happens on the very
//                   first night of the game (round 1) - they're skipped in every
//                   beginNight() after that, even though they're still alive.
//   linkedCountRoleId - set to another role's id to make the setup screen show this
//                   role's headcount as a read-only number that always mirrors that
//                   other role's count, instead of a toggle/number input (see Kőműves,
//                   which always matches the number of gyilkos).
//   immuneToKill  - true if the gyilkosok's night kill never works on this role
//                   (see Katona). Doesn't protect from other death causes (day vote,
//                   Cupido's bond, a Vadász's shot).
//   soloWinIfVotedOut - true if being voted out during the day immediately ends the
//                   game with this player as the sole winner (see Gyári munkás).
//   shootsOnElimination - true if being voted out during the day lets this player
//                   take one more living player down with them before the round
//                   resolves (see Vadász).
//   announceRoleOnDeath - true if this role's name is specifically called out in the
//                   log whenever they die, day or night (see Sarki fűszeres) - unlike
//                   other roles, whose deaths are logged without naming their role.

const ROLES = [
  {
    id: 'polgar',
    name: 'Polgár',
    team: 'polgarok',
    description: 'Nincs különleges képessége. Nappal vitázik és szavaz.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    icon: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"/>',
  },
  {
    id: 'gyilkos',
    name: 'Gyilkos',
    team: 'gyilkosok',
    description: 'Éjjel a többi gyilkossal együtt kiválaszt egy áldozatot.',
    nightAction: 'kill',
    nightOrder: 10,
    actionPrompt: 'A gyilkosok, ébredjetek fel és válasszatok áldozatot!',
    icon: '<path d="M12 2l2 5h-4z"/><line x1="12" y1="7" x2="12" y2="16"/><line x1="8.5" y1="10" x2="15.5" y2="10"/><rect x="10" y="16" width="4" height="6" rx="1.3"/>',
  },
  {
    id: 'nyomozo',
    name: 'Nyomozó',
    team: 'polgarok',
    description: 'Éjjel megvizsgálhat egy játékost, hogy megtudja, gyilkos-e.',
    nightAction: 'investigate',
    nightOrder: 20,
    actionPrompt: 'Nyomozó, ébredj fel és mutass valakit, akit megvizsgálsz!',
    icon: '<circle cx="10" cy="10" r="6.5"/><line x1="21" y1="21" x2="14.8" y2="14.8"/>',
    maxCount: 1,
  },
  {
    id: 'orvos',
    name: 'Orvos',
    team: 'polgarok',
    description: 'Éjjel megvédhet egy játékost a gyilkosságtól (önmagát is).',
    nightAction: 'protect',
    nightOrder: 5,
    actionPrompt: 'Orvos, ébredj fel és mutasd meg, kit védesz meg ma éjjel!',
    icon: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>',
    maxCount: 1,
  },
  {
    id: 'cupido',
    name: 'Cupido',
    team: 'polgarok',
    description: 'Éjjel összeköt két embert arra az éjszakára: ami az egyikkel történik (meghal), az a másikkal is megtörténik. Saját magát is választhatja az egyik félnek. Azt is beköthet, akit az UFO aznap éjjel elrabolt - ilyenkor a párja is az UFO áldozata lesz, így az UFO ezen az éjjelen ketten viszi el. Minden éjjel újraköthet.',
    nightAction: 'link',
    nightOrder: 2,
    actionPrompt: 'Cupido, ébredj fel és köss össze két embert ma éjjelre!',
    icon: '<circle cx="9" cy="9" r="4"/><circle cx="15" cy="9" r="4"/><path d="M4.5 12.5L12 20l7.5-7.5"/>',
    maxCount: 1,
  },
  {
    id: 'komuves',
    name: 'Kőműves',
    team: 'polgarok',
    description: 'Jó barátok, akik ismerik egymást, és tudják, hogy egyikük sem gyilkos. A játék első éjszakáján felébrednek, hogy megismerjék egymást, utána viszont semmi különleges szerepük nincs - onnantól úgy játszanak, mint a polgárok. Mindig annyian vannak, ahány gyilkos van a játékban.',
    nightAction: 'reveal',
    nightOrder: 3,
    actionPrompt: 'Kőművesek, ébredjetek fel, ismerjétek meg egymást, majd aludjatok tovább!',
    icon: '<rect x="2" y="5" width="9" height="6"/><rect x="13" y="5" width="9" height="6"/><rect x="2" y="13" width="4" height="6"/><rect x="8" y="13" width="9" height="6"/><rect x="19" y="13" width="3" height="6"/>',
    onceOnly: true,
    linkedCountRoleId: 'gyilkos',
  },
  {
    id: 'ufo',
    name: 'UFO',
    team: 'polgarok',
    description: 'Éjjel elrabol valakit: azon az éjszakán nem célozható, és ha éjszakai szerepe van, az nem érvényesül (pl. ha az egyetlen élő gyilkost viszi el, az nem tud ölni). Saját magát nem viheti el. Másnap nappal és a következő éjjel már minden normális.',
    nightAction: 'abduct',
    nightOrder: 1,
    actionPrompt: 'UFO, ébredj fel és mutasd meg, kit rabolsz el ma éjjel!',
    icon: '<ellipse cx="12" cy="13" rx="9" ry="3"/><path d="M8.5 13a3.5 3.5 0 0 1 7 0"/><path d="M9 16l-2 5M15 16l2 5M12 16.5v5"/>',
    maxCount: 1,
  },
  {
    id: 'gyarimunkas',
    name: 'Gyári munkás',
    team: 'polgarok',
    description: 'Célja, hogy nappal kiszavazzák - ha ez sikerül, egyedül ő nyer, és a játéknak azonnal vége. Ha éjjel ölik meg, nem éri el a célját, és a játék normálisan folytatódik. Nincs feladata éjszaka.',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    icon: '<path d="M4 16a8 8 0 0 1 16 0z"/><rect x="2" y="16" width="20" height="3" rx="1"/>',
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
    icon: '<path d="M12 3l7 3v6c0 5-3.5 7.5-7 9-3.5-1.5-7-4-7-9V6z"/>',
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
    icon: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/>',
    maxCount: 1,
    shootsOnElimination: true,
  },
  {
    id: 'fuszeres',
    name: 'Sarki fűszeres',
    team: 'polgarok',
    description: 'Nincs feladata. Ha meghal - akár nappal, akár éjjel -, a narrátor kifejezetten bejelenti, hogy a Sarki fűszeres halt meg (a többi szerepnél a halál nem árulja el, ki volt az illető).',
    nightAction: null,
    nightOrder: null,
    actionPrompt: null,
    icon: '<path d="M5 9h14l-1.3 9.5A2 2 0 0 1 15.7 20H8.3a2 2 0 0 1-2-1.5L5 9z"/><path d="M9 9V6.5a3 3 0 0 1 6 0V9"/>',
    maxCount: 1,
    announceRoleOnDeath: true,
  },
  {
    id: 'pek',
    name: 'Pék',
    team: 'polgarok',
    description: 'Éjszakánként pékárut ad valakinek - ennek önmagában nincs hatása, a narrátor csak minden reggel bejelenti, ki kapott kenyeret. Ha a Pék meghal, 3 éjszakával később éhen hal a város és a gyilkosok győznek, ha addig másképp nem dőlt el a játék. Ugyanez történik akkor is, ha az UFO három egymást követő éjszakán elrabolja.',
    nightAction: 'gift',
    nightOrder: 4,
    actionPrompt: 'Pék, ébredj fel és add oda a pékárut valakinek!',
    icon: '<path d="M4 14c0-5 3.5-8 8-8s8 3 8 8-3.5 6-8 6-8-1-8-6z"/><path d="M9 10v8M15 10v8"/>',
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
    icon: '<circle cx="12" cy="9" r="5"/><path d="M9 13l-2 8 5-3 5 3-2-8"/>',
    maxCount: 1,
  },
];
