import { describe, expect, it } from "vitest";
import { productName } from "./index";

describe("shared workspace", () => {
  it("exports the product name", () => {
    expect(productName).toBe("Nexus Decision Arena");
  });
});
