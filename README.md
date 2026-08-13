# cursor-clone-skill — instala com `npm install`

Mesma skill de antes (regra do Cursor + capturador Playwright que clona DOM/CSS/assets de um site
igual a extensão VibeCloner fazia, só que na hora, sem ZIP). A diferença é só o jeito de instalar:
agora é **um `npm install` só**, e ele mesmo copia os arquivos pro seu projeto — não precisa mais
arrastar pasta manualmente.

## Como funciona

Isso é um pacote npm com um script `postinstall` (o mesmo truque que ferramentas tipo `husky`
usam). Quando você roda `npm install <pacote>` dentro de um projeto, o npm instala o pacote e
automaticamente executa `setup.mjs`, que:

1. Copia `.cursor/rules/clone-page.mdc` e `scripts/clone/{capture.mjs,browser-capture.mjs}` pra
   raiz do projeto onde você rodou o `npm install` (não pra dentro de `node_modules`).
2. Se algum desses arquivos já existir e for diferente do que veio no pacote, ele **não sobrescreve**
   — salva como `<arquivo>.new` do lado, pra você comparar/mesclar na mão.
3. Adiciona `clone-capture/` ao `.gitignore` do projeto, se o projeto já tiver um `.gitignore`.
4. Tenta baixar o Chromium do Playwright (`npx playwright install chromium`) automaticamente. Se
   não der (sem internet, sandbox, etc.), só avisa — não quebra o `npm install`.

`playwright` fica como dependência normal do projeto (instalado em `node_modules/`), então o
`scripts/clone/capture.mjs` copiado consegue importar `playwright` normalmente sem precisar de
`node_modules` próprio.

## Instalar num projeto

Você tem duas formas — escolha a que fizer mais sentido pra você:

### Opção A — arquivo local (mais simples, funciona agora)

Guarde `cursor-clone-skill-1.0.0.tgz` em algum lugar fixo (ex.: `~/tools/`) e, em qualquer
projeto:

```bash
npm install ~/tools/cursor-clone-skill-1.0.0.tgz
```

Pronto — ele já copia tudo e tenta baixar o Chromium sozinho.

### Opção B — repositório git privado (funciona de qualquer projeto/máquina sem guardar o .tgz)

Se você subir a pasta `cursor-clone-skill-npm/` (o código-fonte, não o `.tgz`) pra um repositório
seu no GitHub (pode ser privado), qualquer projeto passa a instalar só com:

```bash
npm install github:SEU_USUARIO/cursor-clone-skill
```

Sem precisar copiar arquivo nenhum manualmente — o npm baixa direto do repo. Pra atualizar a
skill depois, é só dar push de novo no repo e rodar `npm install` de novo nos projetos.

## Depois de instalado

No chat do Cursor, dentro do projeto:

> "clona o design de https://exemplo.com nessa página"

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
