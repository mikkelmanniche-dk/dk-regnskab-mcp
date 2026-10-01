import { test } from "node:test";
import assert from "node:assert/strict";
import { rankCompanies, type Candidate } from "../src/cvr.ts";

const company = (cvr: string, name: string, status: string, employeesFrom: number, score: number): Candidate => ({
  cvr, name, status, companyType: null, industry: null, address: null, employees: null, employeesFrom, score,
});

test("search ranking: active first, then exact name, then size, then text match", () => {
  const ranked = rankCompanies(
    [
      company("1", "Lego Boye", "Ophørt", 0, 62),
      company("2", "LEGO SYSTEM A/S", "NORMAL", 7197, 40),
      company("3", "LEGO A/S", "NORMAL", 1, 55),
      company("4", "LEGO FONDEN", "NORMAL", 46, 55),
      company("5", "LEGO House A/S", "NORMAL", 370, 45),
    ],
    "lego",
  );
  assert.deepEqual(ranked.map((c) => c.cvr), ["3", "2", "5", "4", "1"]);
  assert.ok(!("score" in ranked[0]!) && !("employeesFrom" in ranked[0]!));
});

test("search ranking: the legal form is ignored on both sides of the exact match", () => {
  const ranked = rankCompanies(
    [company("1", "Novo Nordisk Kunstforening", "Aktiv", 0, 526), company("2", "NOVO NORDISK A/S", "NORMAL", 27279, 400)],
    "Novo Nordisk A/S",
  );
  assert.equal(ranked[0]!.cvr, "2");
});
