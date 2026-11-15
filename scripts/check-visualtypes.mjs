#!/usr/bin/env node
// Print the visualType enum from the visualConfiguration schema that the container
// schema references, so new visuals only use types Desktop is known to accept.
import { writeFileSync } from 'node:fs';

const url = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/visualConfiguration/2.7.0/schema-embedded.json';
const res = await fetch(url);
const text = await res.text();
writeFileSync('/tmp/vcfg-2.7.0.json', text);
console.log('bytes:', text.length);
const doc = JSON.parse(text);
const visit = (node, path) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.enum) && node.enum.length > 5) {
    console.log(`\n=== enum at ${path} (${node.enum.length} values) ===`);
    console.log(node.enum.join(', '));
  }
  for (const [k, v] of Object.entries(node)) visit(v, `${path}.${k}`);
};
visit(doc, '$');
