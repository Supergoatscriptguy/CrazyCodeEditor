// Runs programs through the JS interpreter and diffs stdout against CPython's.
//   node tools/test-pyjs.mjs [filter]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyjs-')), 'pyjs.mjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src/pyjs/index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  outfile: outFile,
  logLevel: 'error',
});
const { PyJsRuntime } = await import(pathToFileURL(outFile).href);

const T = [];
const test = (name, code, expect, opts = {}) => T.push({ name, code, expect, ...opts });

test('arithmetic', `
print(1 + 2, 7 // 2, 7 % 2, 2 ** 10, 7 / 2)
print(-7 // 2, -7 % 2, divmod(-7, 2))
print(10 ** 25)
print(3.0, 1e16, 0.1 + 0.2, 1 / 3)
print(round(2.5), round(3.5), round(2.675, 2))
print(abs(-5), min(3, 1, 2), max([4, 9, 2]))
print(5 == 5.0, 1 == True, int("42") + 1, float("2.5"))
`, `3 3 1 1024 3.5
-4 1 (-4, 1)
10000000000000000000000000
3.0 1e+16 0.30000000000000004 0.3333333333333333
2 4 2.67
5 1 9
True True 43 2.5`);

test('strings', `
s = "Hello, World"
print(s.upper(), s.lower(), len(s))
print(s.split(", "), "-".join(["a", "b", "c"]))
print(s[0], s[-1], s[7:], s[::-1])
print(s.replace("World", "there"))
print("  pad  ".strip() + "|", "x".rjust(5, "."), "%s has %d" % ("cat", 4))
print(f"{3.14159:.2f} {42:5d} {42:<5}| {'hi':^6}| {255:x} {1234567:,}")
name = "Ana"; age = 7
print(f"{name} is {age} year{'s' if age != 1 else ''} old")
print("abc".isalpha(), "123".isdigit(), "a1".isalnum())
`, `HELLO, WORLD hello, world 12
['Hello', 'World'] a-b-c
H d World dlroW ,olleH
Hello, there
pad| ....x cat has 4
3.14    42 42   |   hi  | ff 1,234,567
Ana is 7 years old
True True True`);

test('containers', `
xs = [3, 1, 2]
xs.append(4); xs.sort(); print(xs, sorted(xs, reverse=True))
print([x * x for x in range(5) if x % 2 == 0])
d = {"a": 1, "b": 2}
d["c"] = 3
print(d, list(d.keys()), sorted(d.items()))
print({k: v * 2 for k, v in d.items()})
print(d.get("z", 0), "a" in d, len(d))
s = {1, 2, 3} | {3, 4}
print(sorted(s), sorted({1, 2} & {2, 3}))
t = (1, "two", 3.0)
a, b, c = t
print(t, a, b, c, t[1])
first, *rest = [1, 2, 3, 4]
print(first, rest)
print(list(zip([1, 2], "ab")), list(enumerate("ab", 1)))
`, `[1, 2, 3, 4] [4, 3, 2, 1]
[0, 4, 16]
{'a': 1, 'b': 2, 'c': 3} ['a', 'b', 'c'] [('a', 1), ('b', 2), ('c', 3)]
{'a': 2, 'b': 4, 'c': 6}
0 True 3
[1, 2, 3, 4] [2]
(1, 'two', 3.0) 1 two 3.0 two
1 [2, 3, 4]
[(1, 'a'), (2, 'b')] [(1, 'a'), (2, 'b')]`);

test('functions', `
def greet(name, greeting="Hello", *args, punct="!", **kw):
    extra = " ".join(args)
    tail = "".join(f" {k}={v}" for k, v in sorted(kw.items()))
    return f"{greeting}, {name}{punct}{(' ' + extra) if extra else ''}{tail}"

print(greet("Ana"))
print(greet("Bo", "Hi", "x", "y", punct="?", mood="glad"))

def counter():
    n = 0
    def inc():
        nonlocal n
        n += 1
        return n
    return inc
c = counter()
print(c(), c(), c())
print((lambda x, y=2: x * y)(5))
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
print([fib(i) for i in range(10)])
print(list(map(lambda x: x * 2, [1, 2, 3])), list(filter(lambda x: x > 1, [1, 2, 3])))
`, `Hello, Ana!
Hi, Bo? x y mood=glad
1 2 3
10
[0, 1, 1, 2, 3, 5, 8, 13, 21, 34]
[2, 4, 6] [2, 3]`);

test('classes', `
class Animal:
    kind = "animal"
    def __init__(self, name):
        self.name = name
    def speak(self):
        return "..."
    def __repr__(self):
        return f"{type(self).__name__}({self.name!r})"

class Dog(Animal):
    kind = "dog"
    def __init__(self, name, tricks=None):
        super().__init__(name)
        self.tricks = tricks or []
    def speak(self):
        return "Woof"
    def __len__(self):
        return len(self.tricks)
    def __eq__(self, other):
        return isinstance(other, Dog) and other.name == self.name

d = Dog("Rex", ["sit"])
print(d, d.speak(), d.kind, len(d))
print(isinstance(d, Animal), issubclass(Dog, Animal), d == Dog("Rex"), d == 5)

class Temp:
    def __init__(self, c):
        self._c = c
    @property
    def f(self):
        return self._c * 9 / 5 + 32
    @f.setter
    def f(self, value):
        self._c = (value - 32) * 5 / 9
    @staticmethod
    def freezing():
        return 0

t = Temp(100)
print(t.f)
t.f = 32
print(t._c, Temp.freezing())

class Vec:
    def __init__(self, x, y):
        self.x, self.y = x, y
    def __add__(self, o):
        return Vec(self.x + o.x, self.y + o.y)
    def __str__(self):
        return f"Vec({self.x}, {self.y})"
print(Vec(1, 2) + Vec(3, 4))
`, `Dog('Rex') Woof dog 1
True True True False
212.0
0.0 0
Vec(4, 6)`);

test('control flow', `
total = 0
for i in range(1, 11):
    if i % 3 == 0:
        continue
    if i > 8:
        break
    total += i
else:
    total = -1
print(total)

n = 0
while True:
    n += 1
    if n >= 3:
        break
print(n)

for x in []:
    pass
else:
    print("empty else ran")

print("yes" if total > 0 else "no")
grid = [[1, 2], [3, 4]]
print([v for row in grid for v in row])
`, `27
3
empty else ran
yes
[1, 2, 3, 4]`);

test('exceptions', `
def risky(x):
    if x == 0:
        raise ValueError("zero not allowed")
    return 10 / x

for v in [2, 0, "a"]:
    try:
        print(risky(v))
    except ValueError as e:
        print("ValueError:", e)
    except TypeError as e:
        print("TypeError caught")
    else:
        print("no error")
    finally:
        print("done", v)

try:
    {}["missing"]
except KeyError as e:
    print("KeyError", e)
try:
    [1, 2][9]
except IndexError as e:
    print("IndexError:", e)
try:
    int("abc")
except ValueError as e:
    print("bad int")

class MyError(Exception):
    pass
try:
    raise MyError("custom")
except Exception as e:
    print(type(e).__name__, e)
`, `5.0
no error
done 2
ValueError: zero not allowed
done 0
TypeError caught
done a
KeyError 'missing'
IndexError: list index out of range
bad int
MyError custom`);

test('generators', `
def countdown(n):
    while n > 0:
        yield n
        n -= 1
    return "done"

print(list(countdown(3)))
g = countdown(2)
print(next(g), next(g))

def squares(limit):
    for i in range(limit):
        yield i * i
print([s for s in squares(5)])
print(sum(squares(5)))

def chain2(a, b):
    yield from a
    yield from b
print(list(chain2([1, 2], "xy")))
`, `[3, 2, 1]
2 1
[0, 1, 4, 9, 16]
30
[1, 2, 'x', 'y']`);

test('modules', `
import math, json
from collections import Counter, defaultdict
import itertools

print(math.sqrt(16), math.floor(2.7), math.pi > 3.14, math.factorial(10))
print(json.dumps({"b": 1, "a": [1, 2]}))
print(json.loads('{"x": [1, 2.5, null, true]}'))
c = Counter("mississippi")
print(c["s"], c["z"], c.most_common(2))
dd = defaultdict(list)
dd["k"].append(1)
print(dd["k"], dd["new"])
print(list(itertools.combinations([1, 2, 3], 2)))
print(list(itertools.islice(itertools.count(10), 3)))
import statistics
print(statistics.mean([1, 2, 3, 4]), statistics.median([3, 1, 2]))
import re
m = re.search(r"(\\w+)@(\\w+)\\.com", "mail bob@site.com here")
print(m.group(0), m.group(1), m.group(2))
print(re.findall(r"\\d+", "a1b22c333"), re.sub(r"\\s+", "_", "a b  c"))
`, `4.0 2 True 3628800
{"b": 1, "a": [1, 2]}
{'x': [1, 2.5, None, True]}
4 0 [('i', 4), ('s', 4)]
[1] []
[(1, 2), (1, 3), (2, 3)]
[10, 11, 12]
2.5 2
bob@site.com bob site
['1', '22', '333'] a_b_c`);

test('files', `
with open("data.txt", "w") as f:
    f.write("line one\\n")
    f.write("line two\\n")

with open("data.txt") as f:
    print(f.read().strip())

with open("data.txt") as f:
    for i, line in enumerate(f.readlines(), 1):
        print(i, line.strip())
import os
print("data.txt" in os.listdir())
`, `line one
line two
1 line one
2 line two
True`);

test('input', `
name = input("Name? ")
age = int(input("Age? "))
print(f"Hi {name}, next year you are {age + 1}")
`, `Name? Age? Hi Ana, next year you are 8`, { inputs: ['Ana', '7'] });

test('traceback', `
def inner(x):
    return x / 0

def outer():
    return inner(5)

outer()
`, `Traceback (most recent call last):
  File "main.py", line 8, in <module>
    outer()
  File "main.py", line 6, in outer
    return inner(5)
  File "main.py", line 3, in inner
    return x / 0
ZeroDivisionError: division by zero`, { expectStderr: true, expectFail: true });

test('sorting and keys', `
words = ["banana", "Apple", "cherry"]
print(sorted(words), sorted(words, key=str.lower if False else (lambda w: w.lower())))
people = [("Bo", 30), ("Ana", 25), ("Cy", 35)]
print(sorted(people, key=lambda p: p[1]))
print(max(people, key=lambda p: p[1]), min(people, key=lambda p: p[1]))
nums = [5, 2, 9]
nums.sort(reverse=True)
print(nums)
print(sorted("hello"))
`, `['Apple', 'banana', 'cherry'] ['Apple', 'banana', 'cherry']
[('Ana', 25), ('Bo', 30), ('Cy', 35)]
('Cy', 35) ('Ana', 25)
[9, 5, 2]
['e', 'h', 'l', 'l', 'o']`);

test('unicode identifiers and text', `
café = 3
naïve_total = café * 2
print(café, naïve_total)
s = "José — café ☕"
print(s, len(s))
print(s.upper())
print("é" in s, s.split(" ")[0])
`, `3 6
José — café ☕ 13
JOSÉ — CAFÉ ☕
True José`);

test('multi-file import', `
from helper import add, VALUE
import helper
print(add(2, 3), VALUE, helper.add(1, 1))
`, `5 42 2`, { files: { 'helper.py': 'VALUE = 42\n\ndef add(a, b):\n    return a + b\n' } });

const filter = process.argv[2];
let pass = 0;
const failures = [];

for (const t of T) {
  if (filter && !t.name.includes(filter)) continue;
  process.stdout.write(`  .... ${t.name}
`);
  let out = '';
  const queue = [...(t.inputs ?? [])];
  const rt = new PyJsRuntime({
    write: (text) => (out += text),
    requestInput: async (prompt) => {
      out += prompt;
      return queue.length ? queue.shift() : null;
    },
    yieldToUi: () => new Promise((r) => setImmediate(r)),
  });
  rt.setFiles({ 'main.py': t.code, ...(t.files ?? {}) });
  let result;
  try {
    result = await rt.run(t.code, 'main.py');
  } catch (e) {
    failures.push({ name: t.name, why: 'threw: ' + (e.stack ?? e) });
    continue;
  }
  const got = out.trimEnd();
  const want = t.expect.trimEnd();
  if (got === want && (t.expectFail ? !result.ok : result.ok)) {
    pass++;
    console.log(`  ok   ${t.name}`);
  } else {
    failures.push({ name: t.name, want, got, result });
  }
}

console.log(`\n${pass}/${pass + failures.length} passed`);
for (const f of failures) {
  console.log(`\n--- FAIL ${f.name}`);
  if (f.why) {
    console.log(f.why);
    continue;
  }
  const wantLines = f.want.split('\n');
  const gotLines = f.got.split('\n');
  for (let i = 0; i < Math.max(wantLines.length, gotLines.length); i++) {
    if (wantLines[i] !== gotLines[i]) {
      console.log(`  line ${i + 1}\n    want: ${JSON.stringify(wantLines[i])}\n    got:  ${JSON.stringify(gotLines[i])}`);
    }
  }
  if (!f.result?.ok && !f.expectFail) console.log('  (program exited non-zero)');
}
process.exit(failures.length ? 1 : 0);
