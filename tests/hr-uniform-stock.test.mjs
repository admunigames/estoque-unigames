import assert from "node:assert/strict";
import test from "node:test";

const {
  PIECE_TYPES,
  SIZES,
  isPieceType,
  isSize,
  isMovementType,
  isTermStatus,
  stockItemId,
  resolveMovementDelta,
} = await import("../app/lib/hr-uniform-stock.ts");

test("PIECE_TYPES e SIZES têm os valores esperados", () => {
  assert.deepEqual(PIECE_TYPES, ["unitec", "unigames", "pa", "lider", "adm", "casacos"]);
  assert.deepEqual(SIZES, ["P", "M", "G", "GG", "XGG", "XXGG"]);
});

test("isPieceType/isSize/isMovementType/isTermStatus validam só os valores do catálogo", () => {
  assert.equal(isPieceType("casacos"), true);
  assert.equal(isPieceType("camisas"), false);
  assert.equal(isSize("GG"), true);
  assert.equal(isSize("EXTRA"), false);
  assert.equal(isMovementType("ajuste"), true);
  assert.equal(isMovementType("transferencia"), false);
  assert.equal(isTermStatus("assinado"), true);
  assert.equal(isTermStatus("pendente"), false);
});

test("stockItemId monta a PK natural 'tipo:tamanho'", () => {
  assert.equal(stockItemId("casacos", "GG"), "casacos:GG");
});

test("resolveMovementDelta: saída sempre -1, entrada sempre +1, independente da quantidade informada", () => {
  assert.equal(resolveMovementDelta("saida", 999), -1);
  assert.equal(resolveMovementDelta("entrada", 999), 1);
});

test("resolveMovementDelta: ajuste usa o delta livre informado (positivo ou negativo)", () => {
  assert.equal(resolveMovementDelta("ajuste", 12), 12);
  assert.equal(resolveMovementDelta("ajuste", -3), -3);
  assert.equal(resolveMovementDelta("ajuste", 0), 0);
});
