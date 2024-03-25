#!/usr/bin/env -S yarn tsx

import { exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fs, path, chalk, echo, glob } from 'zx';

import IcuParser from '@formatjs/icu-messageformat-parser';
import { ErrorKind } from '@formatjs/icu-messageformat-parser/error';

import PO from 'pofile';

const $SELF = fileURLToPath(import.meta.url);
const $BIN = path.dirname($SELF);
const $ROOT = path.dirname($BIN);
const SELF = path.relative($ROOT, $SELF);

function printHelp(error?: string): never {
    echo(`Usage: ${SELF} targetDirectory`);

    if (error) {
        echo('\xa0');
        echo(chalk.red(error));
        exit(1);
    }

    exit(0);
}

const args = parseArgs({
    strict: true,
    allowPositionals: true,
    options: {
        help: { type: 'boolean', short: 'h', multiple: false },
        filename: { type: 'string', short: 'f', multiple: false },
        ignoreKind: { type: 'string', short: 'i', multiple: true },
    },
});
if (args.values.help) printHelp();

let ignoredKinds = new Set<string>();
if (args.values.ignoreKind) {
    const invalidKinds = args.values.ignoreKind.filter(k => !(k in ErrorKind));
    if (invalidKinds.length) printHelp(`Invalid error kinds: ${invalidKinds.join(', ')}`);

    ignoredKinds = new Set<string>(args.values.ignoreKind);
    echo(chalk.dim(`Ignoring error kinds: ${Array.from(ignoredKinds).join(', ')}`));
}

const source: string = args.positionals[0];
if (!source) printHelp('No source directory specified!');

const sourceStat = fs.lstatSync(source, { throwIfNoEntry: false });
if (!sourceStat?.isDirectory()) printHelp('Input path is not a directory!');

const files = await glob(path.join(source, args.values.filename ? `**/${args.values.filename}.po` : '**/*.po'));

type PoEntry = PO['items'][number];

function indent(text: string, level = 1): string {
    return text
        .split('\n')
        .map(line => ' '.repeat(level * 4) + line)
        .join('\n');
}
function isNop(ast: IcuParser.MessageFormatElement[]): boolean {
    // If the AST is empty, there is nothing to validate
    if (!ast.length) return true;

    // If the AST is a single literal, there is nothing to validate
    if (ast.length === 1 && ast[0].type === IcuParser.TYPE.literal) return true;

    return false;
}
function checkIcuMessage(entry: PoEntry): null | string {
    const msgInput = entry.msgid;
    const msgOutput = entry.msgstr[0];
    const opt: IcuParser.ParserOptions = {
        ignoreTag: true,
        captureLocation: true,
        requiresOtherClause: true,
    };

    const res: string[] = [];
    function fail(context: 'input' | 'output', e: string) {
        const txt = [
            // Title
            `${chalk.bold(`Error in ${chalk.underline(context)} message:`)} ${chalk.red(e)}`,
            // Message
            `    ${chalk.yellowBright(msgOutput)}`,
        ];

        // For output, also include the input message
        if (context === 'output') {
            txt.push(
                // Title
                chalk.bold('Input message'),
                // Input message
                `    ${chalk.greenBright(msgInput)}`,
            );
        }

        return res.push(txt.join('\n\n'));
    }

    try {
        const ast = IcuParser.parse(msgInput, opt);
        if (isNop(ast)) return null;
    } catch (e: any) {
        const kind = e.message;
        if (ignoredKinds.has(kind)) return null;
        fail('input', kind);
    }

    // No sense in checking the output if it's empty
    if (msgOutput) {
        try {
            const ast = IcuParser.parse(msgOutput, opt);
            if (isNop(ast)) fail('output', 'Missing ICU formatting?');
        } catch (e: any) {
            const kind = e.message;
            if (ignoredKinds.has(kind)) return null;
            fail('output', kind);
        }
    }

    const line = chalk.dim('─'.repeat(80));
    return res.length ? [...res, line].join('\n\n') : null;
}

let errorsCount = 0;
for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const po = PO.parse(content);

    const entriesErrors: string[] = [];
    po.items.forEach(entry => {
        const error = checkIcuMessage(entry);
        if (error) entriesErrors.push(error);
    });

    if (entriesErrors.length) {
        errorsCount += entriesErrors.length;

        echo('\n');
        echo(chalk.bold.underline(file));
        echo('\n');
        echo(indent(entriesErrors.join('\n\n')));
    }
}

if (errorsCount) {
    echo(chalk.red(`\nFound ${errorsCount} ICU formatting errors!`));
    exit(1);
}

echo(chalk.green('No ICU formatting errors found!'));
exit(0);
