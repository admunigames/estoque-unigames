import assert from "node:assert/strict";
import test from "node:test";

const { sellerUsernameBase } = await import("../app/lib/seller-username.ts");

test("usuário do vendedor = primeiro + segundo nome, sem acento e sem DE/DA/DOS", () => {
  assert.equal(sellerUsernameBase("DOUGLAS SANTOS DE OLIVEIRA"), "douglas.santos");
  assert.equal(sellerUsernameBase("ANA MARIA DA SILVA"), "ana.maria");
  assert.equal(sellerUsernameBase("JOÃO DOS SANTOS"), "joao.santos");
  assert.equal(sellerUsernameBase("BRENNDHA"), "brenndha");
  assert.equal(sellerUsernameBase("LU"), "lu.vendedor");
});
