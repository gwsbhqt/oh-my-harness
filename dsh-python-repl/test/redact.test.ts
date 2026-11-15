import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { homedir } from 'node:os'
import { redactHome } from '../src/redact.ts'

it('collapses the home directory so error text carries no account name or long absolute path', () => {
  const home = homedir()
  assert.equal(redactHome(`${home}/a/b.py`), '~/a/b.py')
  assert.equal(redactHome(`see ${home} and ${home}/x`), 'see ~ and ~/x')
  assert.equal(redactHome('no home here'), 'no home here')
  assert.equal(redactHome(''), '')
})
