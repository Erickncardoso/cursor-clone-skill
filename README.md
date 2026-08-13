# cursor-clone-skill — instala com `npm install`

Isso é uma **Cursor Skill de verdade** (`.cursor/skills/clone-page/SKILL.md`), não uma Rule.
Skill é o mecanismo certo pra um procedimento de várias etapas que só roda quando você pede —
fica sem custo até o agente decidir que é relevante (ou você invoca direto com `/clone-page`),
diferente de uma Rule, que é pensada pra convenção sempre-ativa (tipo "sempre use TypeScript").

Faz a mesma coisa que a extensão VibeCloner fazia (clona DOM/CSS/assets de um site), só que na
hora, sem ZIP. A instalação também é só **um `npm install`** — ele mesmo copia os arquivos pro seu
projeto, não precisa arrastar pasta manualmente.

## Como funciona

Isso é um pacote npm com um script `postinstall` (o mesmo truque que ferramentas tipo `husky`
usam). Quando você roda `npm install <pacote>` dentro de um projeto, o npm instala o pacote e
automaticamente executa `setup.mjs`, que:

1. Copia `.cursor/skills/clone-page/` inteira (SKILL.md + scripts/capture.mjs +
   scripts/browser-capture.mjs) pra raiz do projeto onde você rodou o `npm install` (não pra
   dentro de `node_modules`).
2. Se algum desses arquivos já existir e for diferente do que veio no pacote, ele **não sobrescreve**
   — salva como `<arquivo>.new` do lado, pra você comparar/mesclar na mão.
3. Adiciona `clone-capture/` ao `.gitignore` do projeto, se o projeto já tiver um `.gitignore`.
4. Tenta baixar o Chromium do Playwright (`npx playwright install chromium`) automaticamente. Se
   não der (sem internet, sandbox, etc.), só avisa — não quebra o `npm install`.

`playwright` fica como dependência normal do projeto (instalado em `node_modules/`), então o
`capture.mjs` copiado consegue importar `playwright` normalmente sem precisar de `node_modules`
próprio.

## Instalar num projeto

```bash
npm install github:Erickncardoso/cursor-clone-skill
```

Sem precisar copiar arquivo nenhum manualmente — o npm baixa direto do repo. Pra atualizar a
skill depois, é só dar push de novo no repo e rodar `npm install` de novo (ou `npm update
cursor-clone-skill`) nos projetos que já têm ela instalada.

Se preferir guardar um `.tgz` local em vez de puxar do GitHub toda vez (`npm pack` gera esse
arquivo a partir deste código-fonte), também funciona:

```bash
npm install ~/tools/cursor-clone-skill-1.0.0.tgz
```

## Depois de instalado

No chat do Cursor, dentro do projeto, peça naturalmente:

> "clona o design de https://exemplo.com nessa página"

ou invoque direto:

> `/clone-page https://exemplo.com`

## Reinstalar/atualizar manualmente

Se o `postinstall` for pulado (ex.: `npm install --ignore-scripts`) ou você quiser rodar de novo
depois de uma atualização:

```bash
npx cursor-clone-skill
```

## Nota sobre tamanho

`playwright` traz o Chromium (algumas centenas de MB) na primeira instalação. Se isso for pesado
demais pra rodar em todo projeto, me avisa que eu troco pra uma versão onde o Chromium só baixa
sob demanda, na primeira vez que você realmente pedir uma clonagem — em vez de no `npm install`.
