import assert from "node:assert/strict";
import { combineCsvTexts } from "../lib/csv-combine";

const H = "business_name,contact_name,phone";

// Single file → unchanged (trimmed)
assert.equal(combineCsvTexts([`${H}\nAcme,John,111`]), `${H}\nAcme,John,111`);

// Empty / whitespace-only inputs are dropped
assert.equal(combineCsvTexts(["", "   ", "\n"]), "");

// Two files, same header → header kept once, all data rows appended
assert.equal(
  combineCsvTexts([`${H}\nAcme,John,111`, `${H}\nBeta,Sue,222`]),
  `${H}\nAcme,John,111\nBeta,Sue,222`,
);

// Header match is whitespace/case-insensitive (dropped on the 2nd file)
assert.equal(
  combineCsvTexts([`${H}\nAcme,John,111`, `Business_Name, Contact_Name, Phone\nBeta,Sue,222`]),
  `${H}\nAcme,John,111\nBeta,Sue,222`,
);

// A leading BOM on a later file doesn't break header de-dup
assert.equal(
  combineCsvTexts([`${H}\nAcme,John,111`, `﻿${H}\nBeta,Sue,222`]),
  `${H}\nAcme,John,111\nBeta,Sue,222`,
);

// Blank lines inside files are skipped
assert.equal(
  combineCsvTexts([`${H}\nAcme,John,111\n\n`, `${H}\n\nBeta,Sue,222`]),
  `${H}\nAcme,John,111\nBeta,Sue,222`,
);

console.log("csv-combine tests passed");
