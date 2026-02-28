import { chromium } from "playwright";
import * as path from "path";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto("file://" + path.resolve(__dirname, "index.html"));

  const client = await page.context().newCDPSession(page);
  await client.send("Accessibility.enable");
  const { nodes } = await client.send("Accessibility.getFullAXTree") as any;

  const byId: Record<string, any> = {};
  for (const n of nodes) byId[n.nodeId] = n;

  function sum(n: any, depth = 0): string {
    if (!n) return "null";
    const indent = "  ".repeat(depth);
    let line = `${indent}[${n.nodeId}] ${n.role?.value}: "${n.name?.value || ""}"`;
    if (n.backendDOMNodeId) line += ` (dom:${n.backendDOMNodeId})`;
    return line;
  }

  function printTree(nodeId: string, depth = 0, maxDepth = 4) {
    const n = byId[nodeId];
    if (!n || depth > maxDepth) return;
    console.log(sum(n, depth));
    for (const cid of (n.childIds || [])) {
      printTree(cid, depth + 1, maxDepth);
    }
  }

  // Find the first form-group (parent of first textbox)
  const firstTextbox = nodes.find((n: any) => n.role?.value === "textbox");
  const fgParent = byId[firstTextbox.parentId]; // form-group div

  console.log("=== First form-group (firstName) ===");
  printTree(fgParent.nodeId);

  console.log("\n=== First combobox form-group ===");
  const firstCombo = nodes.find((n: any) => n.role?.value === "combobox");
  const cgParent = byId[firstCombo.parentId];
  printTree(cgParent.nodeId);

  // Show combobox options
  console.log("\n=== Combobox options (first 3 levels) ===");
  printTree(firstCombo.nodeId, 0, 3);

  // Check what LabelText nodes look like
  console.log("\n=== All LabelText nodes ===");
  const labels = nodes.filter((n: any) => n.role?.value === "LabelText");
  for (const l of labels.slice(0, 5)) {
    printTree(l.nodeId, 0, 2);
    console.log("---");
  }

  await browser.close();
}

main();
