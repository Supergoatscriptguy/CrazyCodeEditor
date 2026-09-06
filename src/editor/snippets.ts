// Snippets for keywords; Jedi supplies the names.
import { snippetCompletion, type Completion } from '@codemirror/autocomplete';

const kw = (label: string, template: string, detail: string): Completion => snippetCompletion(template, { label, detail, type: 'keyword', boost: 1 });

export const SNIPPETS: Completion[] = [
  kw('if', 'if ${cond}:\n\t${}', 'if statement'),
  kw('elif', 'elif ${cond}:\n\t${}', 'elif clause'),
  kw('else', 'else:\n\t${}', 'else clause'),
  kw('for', 'for ${item} in ${items}:\n\t${}', 'for loop'),
  kw('while', 'while ${cond}:\n\t${}', 'while loop'),
  kw('def', 'def ${name}(${args}):\n\t${}', 'function'),
  kw('class', 'class ${Name}:\n\tdef __init__(self${, args}):\n\t\t${}', 'class'),
  kw('try', 'try:\n\t${}\nexcept ${Exception} as e:\n\t${}', 'try / except'),
  kw('with', 'with ${expr} as ${name}:\n\t${}', 'with statement'),
  kw('import', 'import ${module}', 'import'),
  kw('from', 'from ${module} import ${name}', 'from import'),
  kw('lambda', 'lambda ${args}: ${expr}', 'lambda'),
  kw('return', 'return ${}', 'return'),
  kw('main', 'if __name__ == "__main__":\n\t${main()}', 'main guard'),
  kw('print', 'print(${})', 'print(...)'),
  kw('input', 'input(${"prompt"})', 'input(prompt)'),
  kw('range', 'range(${n})', 'range(...)'),
  kw('enumerate', 'enumerate(${items})', 'enumerate(...)'),
  kw('open', 'open(${"file"}, ${"r"}) as ${f}', 'open(...)'),
];

// plain keywords with no snippet
const PLAIN_KEYWORDS = ['and', 'as', 'assert', 'async', 'await', 'break', 'continue', 'del', 'except', 'finally', 'global', 'in', 'is', 'nonlocal', 'not', 'or', 'pass', 'raise', 'yield', 'True', 'False', 'None'];
for (const k of PLAIN_KEYWORDS) SNIPPETS.push({ label: k, type: 'keyword' });
