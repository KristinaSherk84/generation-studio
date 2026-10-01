// Delete a customer's files from Vercel Blob (data-removal requests).
//
// Usage (run from the generation-studio folder):
//   BLOB_READ_WRITE_TOKEN="paste-token-here" node scripts/delete_customer_files.mjs ../delete_<name>_files.txt
//
// The text file lists Blob file paths, one per line (other lines are ignored).
// Shows the list and asks you to type "yes" before anything is deleted.
import { del } from "@vercel/blob";
import { readFileSync } from "node:fs";
import readline from "node:readline/promises";

const BASE = "https://1v7nstnczaqna1ul.public.blob.vercel-storage.com/";
const listFile = process.argv[2];
if (!listFile) {
  console.error("Give the list file, e.g. ../delete_mtkuhrau_files.txt");
  process.exit(1);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Missing BLOB_READ_WRITE_TOKEN (copy it from Vercel → Storage → Blob → .env.local).");
  process.exit(1);
}

const paths = readFileSync(listFile, "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^[A-Za-z0-9_./()-]+\.(jpe?g|png|heic|webp)$/i.test(l));

if (paths.length === 0) {
  console.error("No file paths found in that list.");
  process.exit(1);
}

console.log(`\nAbout to PERMANENTLY delete ${paths.length} files:\n`);
paths.forEach((p) => console.log("  " + p));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question('\nType "yes" to delete: ')).trim().toLowerCase();
rl.close();
if (answer !== "yes") {
  console.log("Cancelled. Nothing deleted.");
  process.exit(0);
}

await del(paths.map((p) => BASE + p));
console.log(`\n✓ Deleted ${paths.length} files.`);
