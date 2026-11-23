// Writes docs/schema.md from the built schema (run through `npm run docs:schema`).
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { schemaMarkdown } = require('../dist/schema/doc');
writeFileSync(join(__dirname, '..', 'docs', 'schema.md'), schemaMarkdown());
console.log('wrote docs/schema.md');
