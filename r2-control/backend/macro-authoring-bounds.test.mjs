import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source = readFileSync(new URL('../app/main.js', import.meta.url), 'utf8');
const validation = source.slice(source.indexOf('function bounded('), source.indexOf('function draftMacro(){'));
const context = {mouseButtons: ['left', 'right', 'middle', 'back', 'forward']};
runInNewContext(validation + '\nglobalThis.validate = validateMacro;', context);
test('authored and imported repeat counts match the visible 1..65535 range', () => {
  const macro = repeatCount => ({name: 'Bounds', repeatCount, macro: [{type: 'delay', value: 10}]});
  for (const value of [0, -1, 65536, 1.5, NaN]) assert.throws(() => context.validate(macro(value)), /Repeat count/);
  for (const value of [1, 65535]) assert.equal(context.validate(macro(value)).repeatCount, value);
});
