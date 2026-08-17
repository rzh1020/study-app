// 生成 data/kana.json。用脚本而不是手打整张表，避免录入错漏。
// 运行：node tools/gen_kana.mjs
import { writeFileSync, mkdirSync } from 'fs';
import { KANA_HOOKS, ONYOMI_RULES } from './kana_hooks.mjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// 五十音清音（行 → [罗马音, 平假名, 片假名]），按标准五十音图顺序
const SEION = [
  ['ア行', [['a', 'あ', 'ア'], ['i', 'い', 'イ'], ['u', 'う', 'ウ'], ['e', 'え', 'エ'], ['o', 'お', 'オ']]],
  ['カ行', [['ka', 'か', 'カ'], ['ki', 'き', 'キ'], ['ku', 'く', 'ク'], ['ke', 'け', 'ケ'], ['ko', 'こ', 'コ']]],
  ['サ行', [['sa', 'さ', 'サ'], ['shi', 'し', 'シ'], ['su', 'す', 'ス'], ['se', 'せ', 'セ'], ['so', 'そ', 'ソ']]],
  ['タ行', [['ta', 'た', 'タ'], ['chi', 'ち', 'チ'], ['tsu', 'つ', 'ツ'], ['te', 'て', 'テ'], ['to', 'と', 'ト']]],
  ['ナ行', [['na', 'な', 'ナ'], ['ni', 'に', 'ニ'], ['nu', 'ぬ', 'ヌ'], ['ne', 'ね', 'ネ'], ['no', 'の', 'ノ']]],
  ['ハ行', [['ha', 'は', 'ハ'], ['hi', 'ひ', 'ヒ'], ['fu', 'ふ', 'フ'], ['he', 'へ', 'ヘ'], ['ho', 'ほ', 'ホ']]],
  ['マ行', [['ma', 'ま', 'マ'], ['mi', 'み', 'ミ'], ['mu', 'む', 'ム'], ['me', 'め', 'メ'], ['mo', 'も', 'モ']]],
  ['ヤ行', [['ya', 'や', 'ヤ'], ['yu', 'ゆ', 'ユ'], ['yo', 'よ', 'ヨ']]],
  ['ラ行', [['ra', 'ら', 'ラ'], ['ri', 'り', 'リ'], ['ru', 'る', 'ル'], ['re', 'れ', 'レ'], ['ro', 'ろ', 'ロ']]],
  ['ワ行', [['wa', 'わ', 'ワ'], ['wo', 'を', 'ヲ']]],
  ['撥音', [['n', 'ん', 'ン']]],
];

// 浊音 + 半浊音
const DAKUON = [
  ['ガ行', [['ga', 'が', 'ガ'], ['gi', 'ぎ', 'ギ'], ['gu', 'ぐ', 'グ'], ['ge', 'げ', 'ゲ'], ['go', 'ご', 'ゴ']]],
  ['ザ行', [['za', 'ざ', 'ザ'], ['ji', 'じ', 'ジ'], ['zu', 'ず', 'ズ'], ['ze', 'ぜ', 'ゼ'], ['zo', 'ぞ', 'ゾ']]],
  ['ダ行', [['da', 'だ', 'ダ'], ['ji', 'ぢ', 'ヂ'], ['zu', 'づ', 'ヅ'], ['de', 'で', 'デ'], ['do', 'ど', 'ド']]],
  ['バ行', [['ba', 'ば', 'バ'], ['bi', 'び', 'ビ'], ['bu', 'ぶ', 'ブ'], ['be', 'べ', 'ベ'], ['bo', 'ぼ', 'ボ']]],
  ['パ行', [['pa', 'ぱ', 'パ'], ['pi', 'ぴ', 'ピ'], ['pu', 'ぷ', 'プ'], ['pe', 'ぺ', 'ペ'], ['po', 'ぽ', 'ポ']]],
];

// 拗音：由 i 段假名 + 小写 ゃゅょ 拼成
const YOON_BASE = [
  ['き', 'キ', 'ky', 'sha_no'], ['し', 'シ', 'sh', 'sh'], ['ち', 'チ', 'ch', 'ch'],
  ['に', 'ニ', 'ny', 'ny'], ['ひ', 'ヒ', 'hy', 'hy'], ['み', 'ミ', 'my', 'my'],
  ['り', 'リ', 'ry', 'ry'], ['ぎ', 'ギ', 'gy', 'gy'], ['じ', 'ジ', 'j', 'j'],
  ['び', 'ビ', 'by', 'by'], ['ぴ', 'ピ', 'py', 'py'],
];
const SMALL = [['ゃ', 'ャ', 'a'], ['ゅ', 'ュ', 'u'], ['ょ', 'ョ', 'o']];

function romajiYoon(prefix, vowel) {
  // sh/ch/j 后面不写 y：sha/shu/sho, cha/chu/cho, ja/ju/jo
  return prefix + vowel;
}

const cards = [];
let id = 0;
function push(group, romaji, hira, kata, tag) {
  const card = { id: `kana-${String(++id).padStart(3, '0')}`, group, romaji, hira, kata, tag };
  // 清音才挂字源钩子：浊音/半浊音/拗音都是从清音派生的（加两点/加圈/加小写 ゃゅょ），
  // 给它们单独编钩子是重复劳动，规则卡里讲清派生方式更有效。
  const hook = KANA_HOOKS[hira];
  if (hook) {
    card.srcHira = hook[0];
    card.srcKata = hook[1];
    card.hook = hook[2];
  }
  cards.push(card);
}

for (const [group, rows] of SEION) for (const [r, h, k] of rows) push(group, r, h, k, 'seion');
for (const [group, rows] of DAKUON) for (const [r, h, k] of rows) push(group, r, h, k, 'dakuon');
for (const [h, k, prefix] of YOON_BASE) {
  for (const [sh, sk, v] of SMALL) {
    push(h + 'ゃ行'.replace('ゃ', ''), romajiYoon(prefix, v), h + sh, k + sk, 'yoon');
  }
}

// 长音/促音/拨音等发音规则，做成规则卡而不是死记
const rules = [
  { id: 'rule-000', title: '假名是汉字变来的（最省力的记忆法）', body: '平假名＝汉字草书的简化，片假名＝汉字楷书取部件。这是史实，不是编的联想。\n关键在于：多数假名的声母和源字的汉语声母对得上 ——\nか←加 jiā、き←幾 jī、ま←末 mò、も←毛 máo、ら←良 liáng、り←利 lì。\n片假名更直白：ニ←二（两横）、ミ←三（三笔）、ハ←八、エ←江的「工」、リ←利的「刂」。\n每张假名卡的背面都有它的字源和对应说明，看几遍比抄一百遍有用。' },
  { id: 'rule-009', title: '浊音/半浊音怎么派生', body: '不用单独背 25 个浊音。规则只有两条：\n· 清音右上加两点「゛」→ 浊音：か→が(ka→ga)、さ→ざ、た→だ、は→ば\n· は行右上加小圈「゜」→ 半浊音：は→ぱ(ha→pa)\n发音上就是把清辅音变成对应的浊辅音（k→g、s→z、t→d、h→b）。\n只有は行特殊，因为它同时能变 b 和 p —— 这正是它古音接近 p/f 的证据。' },
  { id: 'rule-010', title: '拗音怎么派生', body: '不用单独背 33 个拗音。规则只有一条：\ni 段假名（き し ち に ひ み り ぎ じ び ぴ）+ 小写的 ゃ/ゅ/ょ，拼成一个音节。\nき+ゃ = きゃ(kya)，し+ゅ = しゅ(shu)，ち+ょ = ちょ(cho)。\n注意罗马音写法：sh/ch/j 后面不写 y —— しゃ=sha 不是 shya，ちゃ=cha，じゃ=ja。\n小写的 ゃゅょ 必须写小，写成大的 や 就是两个独立音节（きや ki-ya ≠ きゃ kya）。' },
  { id: 'rule-001', title: '促音 っ', body: '小写的 っ / ッ 不发音，而是停顿一拍，等于把下一个辅音加倍。\nきって kitte（邮票）· がっこう gakkou（学校）· ちょっと chotto（稍微）' },
  { id: 'rule-002', title: '长音', body: '拉长一拍，算独立音节。平假名靠元音叠加，片假名用「ー」。\nおおきい ookii（大）· とうきょう Toukyou（东京）· コーヒー koohii（咖啡）\n长短会变词义：おじさん 叔叔 / おじいさん 爷爷' },
  { id: 'rule-003', title: 'ん 的三种实际读音', body: 'ん 单独占一拍，但受后一个音影响：\n· 后接 b/p/m → 读 m：さんぽ sampo\n· 后接 k/g → 读 ng：にほんご nihongo\n· 后接 t/d/n/z → 读 n：おんな onna' },
  { id: 'rule-004', title: 'は / へ / を 当助词时变音', body: '作助词时读音变了，这是最容易读错的地方：\n· は → wa（わたしは watashi wa）\n· へ → e（がっこうへ gakkou e）\n· を → o（みずを のむ mizu o nomu）\n不作助词时仍读 ha / he / wo。' },
  { id: 'rule-005', title: 'う段的 u 常被弱化', body: 'です → desu 实际近 des；ます → masu 实际近 mas。\n词尾的 u 音气流很轻，读满会显得生硬。' },
  { id: 'rule-006', title: 'が 的鼻浊音', body: '词中、词尾的 が 行在很多说话人口中带鼻音（近 nga）。\nにほんご 的 ご、あります 里的 が。不强求，但听力上要能对上。' },
  { id: 'rule-007', title: '片假名用在哪', body: '外来语（コンピューター）、拟声拟态词（ドキドキ）、\n强调（マジ）、动植物学名。看动漫时的招式名、拟声词几乎全是片假名，\n所以片假名不能只认不练。' },
  { id: 'rule-008', title: 'し/ち/つ/ふ 的送气', body: 'し=shi 不是 si；ち=chi 不是 ti；つ=tsu 舌尖抵上齿；\nふ=fu 是双唇轻擦，不是英语的 f（不用上齿咬下唇）。' },
];

mkdirSync(join(root, 'data'), { recursive: true });
// 音读规律单独成组：它们不是「假名怎么读」，而是「怎么从汉语推出词的读音」，
// 是整套内容里杠杆最大的一块，值得作为独立牌组反复复习。
const out = { version: 2, cards, rules: [...rules, ...ONYOMI_RULES] };
writeFileSync(join(root, 'data', 'kana.json'), JSON.stringify(out, null, 1), 'utf8');

// 自检
const counts = { seion: 0, dakuon: 0, yoon: 0 };
for (const c of cards) counts[c.tag]++;
const hiraSet = new Set(cards.map((c) => c.hira));
const kataSet = new Set(cards.map((c) => c.kata));
console.log('清音', counts.seion, '(应 46)');
console.log('浊音+半浊音', counts.dakuon, '(应 25)');
console.log('拗音', counts.yoon, '(应 33)');
console.log('合计', cards.length, '(应 104)');
console.log('平假名去重', hiraSet.size, '片假名去重', kataSet.size);
console.log('规则卡', out.rules.length, `(含音读规律 ${ONYOMI_RULES.length} 条)`);
const seion = cards.filter((c) => c.tag === 'seion');
const noHook = seion.filter((c) => !c.hook);
console.log('清音带字源钩子', seion.length - noHook.length, '/', seion.length);
if (noHook.length) { console.error('!! 缺钩子:', noHook.map((c) => c.hira).join(' ')); process.exit(1); }
const badHook = cards.filter((c) => c.hook && (!c.srcHira || !c.srcKata));
if (badHook.length) { console.error('!! 钩子缺字源字段'); process.exit(1); }
const bad = cards.filter((c) => !c.hira || !c.kata || !c.romaji);
console.log('字段缺失', bad.length);
if (counts.seion !== 46 || counts.dakuon !== 25 || counts.yoon !== 33 || bad.length) {
  console.error('!! 数据自检失败');
  process.exit(1);
}
if (hiraSet.size !== cards.length || kataSet.size !== cards.length) {
  console.error('!! 有重复假名（注意 ぢ/づ 与 じ/ず 罗马音相同但字形不同，不应被判重）');
  process.exit(1);
}
console.log('OK -> data/kana.json');
