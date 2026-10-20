import { BadRequestException } from '@nestjs/common';
export function texEscape(value: unknown) {
  return String(value ?? '').replace(
    /[\\{}$&#%_^~]/g,
    (c) =>
      ({
        '\\': '\\textbackslash{}',
        '{': '\\{',
        '}': '\\}',
        $: '\\$',
        '&': '\\&',
        '#': '\\#',
        '%': '\\%',
        _: '\\_',
        '^': '\\textasciicircum{}',
        '~': '\\textasciitilde{}',
      })[c]!,
  );
}
type Node = { text?: string; path?: string; kind?: 'each' | 'if'; children?: Node[] };
function parse(source: string) {
  const root: Node[] = [],
    stack: { kind: string; nodes: Node[] }[] = [{ kind: 'root', nodes: root }];
  let last = 0;
  const re = /{{([\s\S]*?)}}/g;
  let match: RegExpExecArray | null,
    count = 0;
  if (source.length > 100000 || source.includes('{{{'))
    throw new BadRequestException('模板过长或包含不允许的原始变量');
  while ((match = re.exec(source))) {
    if (++count > 5000) throw new BadRequestException('模板变量过多');
    stack.at(-1)!.nodes.push({ text: source.slice(last, match.index) });
    const tag = match[1]!.trim();
    last = re.lastIndex;
    if (tag.startsWith('#')) {
      const m = /^#(each|if) ([a-zA-Z_][\w.]*)$/.exec(tag);
      if (!m || stack.length > 10) throw new BadRequestException('只支持 each、if 和字段变量');
      const node: Node = { kind: m[1] as 'each' | 'if', path: m[2], children: [] };
      stack.at(-1)!.nodes.push(node);
      stack.push({ kind: m[1]!, nodes: node.children! });
    } else if (tag.startsWith('/')) {
      if (stack.length < 2 || stack.at(-1)!.kind !== tag.slice(1))
        throw new BadRequestException('模板块未匹配');
      stack.pop();
    } else {
      if (
        !/^[a-zA-Z_][\w.]*$/.test(tag) ||
        tag.split('.').some((x) => ['__proto__', 'constructor', 'prototype'].includes(x))
      )
        throw new BadRequestException('模板字段无效');
      stack.at(-1)!.nodes.push({ path: tag });
    }
  }
  stack.at(-1)!.nodes.push({ text: source.slice(last) });
  if (stack.length !== 1) throw new BadRequestException('模板块未结束');
  return root;
}
export function renderTemplate(source: string, context: Record<string, unknown>) {
  const nodes = parse(source);
  const get = (path: string, ctx: Record<string, unknown>) =>
    path
      .split('.')
      .reduce<unknown>(
        (v, k) =>
          v && typeof v === 'object' && Object.hasOwn(v, k)
            ? (v as Record<string, unknown>)[k]
            : undefined,
        ctx,
      );
  const parts: string[] = [];
  let visited = 0,
    iterations = 0,
    characters = 0;
  const append = (value: string) => {
    characters += value.length;
    if (characters > 250000) throw new BadRequestException('模板展开结果超过 250000 字符');
    if (value) parts.push(value);
  };
  const render = (ns: Node[], ctx: Record<string, unknown>): void => {
    for (const n of ns) {
      if (++visited > 50000) throw new BadRequestException('模板展开节点过多');
      if (n.text !== undefined) append(n.text);
      else if (n.kind === 'each') {
        const values = get(n.path!, ctx);
        if (Array.isArray(values))
          for (const value of values.slice(0, 100)) {
            if (++iterations > 10000) throw new BadRequestException('模板循环总次数过多');
            render(n.children!, { ...ctx, this: value });
          }
      } else if (n.kind === 'if') {
        if (get(n.path!, ctx)) render(n.children!, ctx);
      } else {
        const value = String(get(n.path!, ctx) ?? '');
        if (value.length > 250000 - characters)
          throw new BadRequestException('模板展开结果超过 250000 字符');
        append(texEscape(value));
      }
    }
  };
  render(nodes, context);
  return parts.join('');
}
