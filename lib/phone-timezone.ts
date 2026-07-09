/**
 * tzFromPhone — best-effort IANA timezone for a US/Canada (NANP) phone number,
 * by area code. Used to show a merchant's LOCAL call time next to the operator's
 * (dual-timezone correctness for cross-country MCA dials). Unknown area code ->
 * null, and callers simply omit the dual line (never guess a wrong zone).
 *
 * Not exhaustive; covers the major metro area codes. DST is handled downstream by
 * Intl.DateTimeFormat({ timeZone }) — never store fixed offsets.
 */

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";
const AZ = "America/Phoenix"; // no DST
const AK = "America/Anchorage";
const HI = "Pacific/Honolulu";

// Area code -> IANA zone. Curated to the highest-population codes per region.
const AREA_TZ: Record<string, string> = {
  // Eastern
  "201": ET, "202": ET, "203": ET, "207": ET, "212": ET, "215": ET, "216": ET, "234": ET, "239": ET, "240": ET,
  "267": ET, "276": ET, "301": ET, "302": ET, "304": ET, "305": ET, "321": ET, "330": ET, "339": ET, "347": ET,
  "351": ET, "352": ET, "386": ET, "401": ET, "404": ET, "407": ET, "410": ET, "412": ET, "413": ET, "419": ET,
  "434": ET, "440": ET, "443": ET, "470": ET, "475": ET, "478": ET, "484": ET, "508": ET, "513": ET, "516": ET,
  "517": ET, "518": ET, "540": ET, "551": ET, "561": ET, "570": ET, "571": ET, "585": ET, "586": ET, "603": ET,
  "607": ET, "609": ET, "610": ET, "614": ET, "616": ET, "617": ET, "631": ET, "646": ET, "678": ET, "703": ET,
  "704": ET, "706": ET, "716": ET, "717": ET, "718": ET, "724": ET, "727": ET, "732": ET, "734": ET, "740": ET,
  "754": ET, "757": ET, "770": ET, "772": ET, "774": ET, "781": ET, "786": ET, "787": ET, "802": ET, "803": ET,
  "804": ET, "810": ET, "813": ET, "814": ET, "828": ET, "839": ET, "843": ET, "845": ET, "848": ET, "856": ET,
  "857": ET, "860": ET, "862": ET, "863": ET, "864": ET, "878": ET, "904": ET, "908": ET, "910": ET, "912": ET,
  "914": ET, "917": ET, "919": ET, "929": ET, "934": ET, "947": ET, "954": ET, "959": ET, "973": ET, "978": ET,
  "980": ET, "984": ET, "989": ET,
  // Central
  "205": CT, "210": CT, "214": CT, "217": CT, "224": CT, "225": CT, "228": CT, "251": CT, "254": CT, "256": CT,
  "262": CT, "270": CT, "281": CT, "309": CT, "312": CT, "314": CT, "316": CT, "318": CT, "319": CT, "331": CT,
  "334": CT, "337": CT, "361": CT, "402": CT, "405": CT, "409": CT, "414": CT, "417": CT, "430": CT, "432": CT,
  "469": CT, "479": CT, "501": CT, "504": CT, "507": CT, "512": CT, "515": CT, "563": CT, "573": CT, "580": CT,
  "601": CT, "608": CT, "612": CT, "615": CT, "618": CT, "620": CT, "629": CT, "630": CT, "636": CT, "641": CT,
  "651": CT, "662": CT, "682": CT, "708": CT, "713": CT, "715": CT, "731": CT, "737": CT, "763": CT, "769": CT,
  "773": CT, "779": CT, "785": CT, "816": CT, "817": CT, "830": CT, "832": CT, "847": CT, "870": CT, "901": CT,
  "913": CT, "915": CT, "918": CT, "920": CT, "931": CT, "936": CT, "940": CT, "952": CT, "956": CT, "972": CT,
  "979": CT,
  // Mountain (DST)
  "303": MT, "307": MT, "385": MT, "406": MT, "435": MT, "505": MT, "575": MT, "719": MT, "720": MT, "801": MT,
  "970": MT,
  // Arizona (no DST)
  "480": AZ, "520": AZ, "602": AZ, "623": AZ, "928": AZ,
  // Pacific
  "206": PT, "209": PT, "213": PT, "253": PT, "279": PT, "310": PT, "323": PT, "341": PT, "360": PT, "408": PT,
  "415": PT, "424": PT, "425": PT, "442": PT, "458": PT, "503": PT, "509": PT, "510": PT, "530": PT, "541": PT,
  "559": PT, "562": PT, "619": PT, "626": PT, "628": PT, "650": PT, "657": PT, "661": PT, "669": PT, "702": PT,
  "707": PT, "714": PT, "725": PT, "747": PT, "760": PT, "775": PT, "805": PT, "818": PT, "820": PT, "831": PT,
  "858": PT, "909": PT, "916": PT, "925": PT, "949": PT, "951": PT, "971": PT,
  // Alaska / Hawaii
  "907": AK, "808": HI,
};

/** Extract the NANP area code from an E.164-ish string and map it to a zone. */
export function tzFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, "");
  // +1XXXXXXXXXX -> strip leading country 1; XXXXXXXXXX -> use as is.
  const nat = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (nat.length < 10) return null;
  return AREA_TZ[nat.slice(0, 3)] ?? null;
}
