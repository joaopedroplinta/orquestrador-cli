import { sep } from "node:path";
import { describe, expect, it } from "vitest";
import { isWithinProjectScope } from "./history.js";

describe("isWithinProjectScope", () => {
  const projectRoot = `${sep}home${sep}user${sep}meuprojeto`;

  it("bate exato quando o cwd é a própria raiz do projeto", () => {
    expect(isWithinProjectScope(projectRoot, projectRoot)).toBe(true);
  });

  it("bate quando o cwd é um descendente da raiz do projeto", () => {
    expect(isWithinProjectScope(`${projectRoot}${sep}src`, projectRoot)).toBe(true);
    expect(isWithinProjectScope(`${projectRoot}${sep}src${sep}sub${sep}mais-fundo`, projectRoot)).toBe(true);
  });

  it("não bate num diretório irmão com prefixo parecido (não é um descendente de verdade)", () => {
    expect(isWithinProjectScope(`${projectRoot}-outro`, projectRoot)).toBe(false);
    expect(isWithinProjectScope(`${projectRoot}2`, projectRoot)).toBe(false);
  });

  it("não bate num diretório pai do projeto", () => {
    expect(isWithinProjectScope(`${sep}home${sep}user`, projectRoot)).toBe(false);
  });

  it("não bate num diretório completamente não relacionado", () => {
    expect(isWithinProjectScope(`${sep}var${sep}log`, projectRoot)).toBe(false);
  });

  it("cwd ausente (runs de antes da coluna existir) nunca bate em nenhum projeto", () => {
    expect(isWithinProjectScope(undefined, projectRoot)).toBe(false);
  });
});
