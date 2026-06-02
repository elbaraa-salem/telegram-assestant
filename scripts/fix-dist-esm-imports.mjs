import fs from "node:fs";
import path from "node:path";

const distDir = path.join(process.cwd(), "dist");
const extensionPattern = /\.[a-zA-Z0-9]+$/;

function listJavaScriptFiles(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return listJavaScriptFiles(entryPath);
    }

    return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
  });
}

function normalizeSpecifier(specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return specifier;
  }

  if (extensionPattern.test(path.basename(specifier))) {
    return specifier;
  }

  return `${specifier}.js`;
}

for (const filePath of listJavaScriptFiles(distDir)) {
  const original = fs.readFileSync(filePath, "utf8");
  const updated = original
    .replace(
      /(\bfrom\s*["'])(\.{1,2}\/[^"']+)(["'])/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${normalizeSpecifier(specifier)}${suffix}`
    )
    .replace(
      /(\bimport\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g,
      (_match, prefix, specifier, suffix) =>
        `${prefix}${normalizeSpecifier(specifier)}${suffix}`
    );

  if (updated !== original) {
    fs.writeFileSync(filePath, updated);
  }
}
