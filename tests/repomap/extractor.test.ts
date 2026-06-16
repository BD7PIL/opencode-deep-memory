import { describe, it, expect } from "vitest";
import { extractSymbols, getLanguage } from "../../src/repomap/extractor.js";

describe("getLanguage", () => {
  it("detects TypeScript extensions", () => {
    expect(getLanguage("foo.ts")).toBe("typescript");
    expect(getLanguage("foo.tsx")).toBe("typescript");
    expect(getLanguage("foo.mts")).toBe("typescript");
    expect(getLanguage("foo.cts")).toBe("typescript");
  });

  it("detects JavaScript extensions", () => {
    expect(getLanguage("foo.js")).toBe("javascript");
    expect(getLanguage("foo.jsx")).toBe("javascript");
    expect(getLanguage("foo.mjs")).toBe("javascript");
    expect(getLanguage("foo.cjs")).toBe("javascript");
  });

  it("detects Python, Go, Rust, Java, C, C++, Ruby", () => {
    expect(getLanguage("foo.py")).toBe("python");
    expect(getLanguage("foo.go")).toBe("go");
    expect(getLanguage("foo.rs")).toBe("rust");
    expect(getLanguage("foo.java")).toBe("java");
    expect(getLanguage("foo.c")).toBe("c");
    expect(getLanguage("foo.h")).toBe("c");
    expect(getLanguage("foo.cpp")).toBe("cpp");
    expect(getLanguage("foo.cc")).toBe("cpp");
    expect(getLanguage("foo.cxx")).toBe("cpp");
    expect(getLanguage("foo.hpp")).toBe("cpp");
    expect(getLanguage("foo.rb")).toBe("ruby");
  });

  it("returns null for unknown extensions", () => {
    expect(getLanguage("foo.txt")).toBeNull();
    expect(getLanguage("foo.md")).toBeNull();
    expect(getLanguage("Makefile")).toBeNull();
    expect(getLanguage("foo")).toBeNull();
  });
});

describe("extractSymbols — TypeScript", () => {
  it("extracts function declarations", () => {
    const code = `export function login(user: string) { }\nfunction logout() { }`;
    const syms = extractSymbols("auth.ts", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "login", type: "function" }),
        expect.objectContaining({ name: "logout", type: "function" }),
      ]),
    );
  });

  it("extracts class declarations", () => {
    const code = `export class AuthManager { }`;
    const syms = extractSymbols("auth.ts", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "AuthManager", type: "class" }),
      ]),
    );
  });

  it("extracts const, type, interface, enum", () => {
    const code = [
      `export const MAX_RETRIES = 3;`,
      `export type UserID = string;`,
      `export interface Config { host: string; }`,
      `export enum Status { Active, Inactive }`,
    ].join("\n");
    const syms = extractSymbols("types.ts", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "MAX_RETRIES", type: "const" }),
        expect.objectContaining({ name: "UserID", type: "type" }),
        expect.objectContaining({ name: "Config", type: "interface" }),
        expect.objectContaining({ name: "Status", type: "enum" }),
      ]),
    );
  });

  it("extracts arrow functions as function type", () => {
    const code = `export const fetchUser = async (id: string) => { };`;
    const syms = extractSymbols("api.ts", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "fetchUser", type: "function" }),
      ]),
    );
  });

  it("reports correct line numbers", () => {
    const code = `// line 1\n// line 2\nexport function doit() { }\n// line 4`;
    const syms = extractSymbols("f.ts", code);
    const doit = syms.find((s) => s.name === "doit");
    expect(doit?.line).toBe(3);
  });
});

describe("extractSymbols — Python", () => {
  it("extracts def and class", () => {
    const code = `def calculate(x, y):\n    return x + y\nclass Parser:\n    def parse(self):\n        pass`;
    const syms = extractSymbols("calc.py", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "calculate", type: "function" }),
        expect.objectContaining({ name: "Parser", type: "class" }),
        expect.objectContaining({ name: "parse", type: "function" }),
      ]),
    );
  });
});

describe("extractSymbols — Go", () => {
  it("extracts free functions, methods, struct, interface", () => {
    const code = [
      `func main() {`,
      `}`,
      `func (s *Server) Handle(w http.ResponseWriter, r *http.Request) {`,
      `}`,
      `type Server struct {`,
      `  addr string`,
      `}`,
      `type Handler interface {`,
      `  Handle()`,
      `}`,
    ].join("\n");
    const syms = extractSymbols("server.go", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "main", type: "function" }),
        expect.objectContaining({ name: "Handle", type: "method" }),
        expect.objectContaining({ name: "Server", type: "struct" }),
        expect.objectContaining({ name: "Handler", type: "interface" }),
      ]),
    );
  });
});

describe("extractSymbols — Rust", () => {
  it("extracts fn, struct, enum, trait", () => {
    const code = [
      `pub fn build() -> Self { }`,
      `pub struct Config { }`,
      `pub enum Token { }`,
      `pub trait Serialize { }`,
    ].join("\n");
    const syms = extractSymbols("lib.rs", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "build", type: "function" }),
        expect.objectContaining({ name: "Config", type: "struct" }),
        expect.objectContaining({ name: "Token", type: "enum" }),
        expect.objectContaining({ name: "Serialize", type: "trait" }),
      ]),
    );
  });
});

describe("extractSymbols — Java", () => {
  it("extracts class, interface, method", () => {
    const code = [
      `public class UserService {`,
      `  public User findById(long id) { }`,
      `}`,
      `public interface Repository { }`,
    ].join("\n");
    const syms = extractSymbols("Service.java", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "UserService", type: "class" }),
        expect.objectContaining({ name: "findById", type: "method" }),
        expect.objectContaining({ name: "Repository", type: "interface" }),
      ]),
    );
  });
});

describe("extractSymbols — C/C++", () => {
  it("extracts function and struct", () => {
    const code = [
      `struct Point {`,
      `  int x;`,
      `  int y;`,
      `};`,
      `int add(int a, int b) {`,
      `  return a + b;`,
      `}`,
    ].join("\n");
    const syms = extractSymbols("math.c", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Point", type: "struct" }),
        expect.objectContaining({ name: "add", type: "function" }),
      ]),
    );
  });
});

describe("extractSymbols — Ruby", () => {
  it("extracts def and class", () => {
    const code = `class Animal\n  def speak\n    "woof"\n  end\nend`;
    const syms = extractSymbols("animal.rb", code);
    expect(syms).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Animal", type: "class" }),
        expect.objectContaining({ name: "speak", type: "function" }),
      ]),
    );
  });
});

describe("extractSymbols — edge cases", () => {
  it("returns empty for unknown language", () => {
    expect(extractSymbols("data.txt", "hello world")).toEqual([]);
    expect(extractSymbols("Makefile", "all: build")).toEqual([]);
  });

  it("returns empty for empty content", () => {
    expect(extractSymbols("foo.ts", "")).toEqual([]);
  });

  it("deduplicates same symbol name+type", () => {
    const code = `export function foo() { }\nexport function foo() { }`;
    const syms = extractSymbols("dup.ts", code);
    const foos = syms.filter((s) => s.name === "foo" && s.type === "function");
    expect(foos).toHaveLength(1);
  });
});
