import * as process from 'node:process';
import * as path from 'node:path';
import {
	createConnection,
	ProposedFeatures,
	TextDocuments,
	RequestType,
	TextDocumentSyncKind,
	ResponseError,
	LSPErrorCodes,
	TextEdit,
	Range,
	Connection,
	InitializeResult,
	DocumentFormattingParams,
	CancellationToken,
	TextDocumentIdentifier,
	DidChangeConfigurationParams,
	TextDocumentChangeEvent,
	CodeAction
} from 'vscode-languageserver/node';
import {TextDocument} from 'vscode-languageserver-textdocument';
import autoBind from 'auto-bind';
import debounce from 'lodash/debounce';
import Queue from 'queue';
import {CodeActionParams} from 'vscode-languageclient';
import isUndefined from 'lodash/isUndefined';
import type {DebouncedFunc} from 'lodash';

import * as utils from './utils.js';
import CodeActionsBuilder from './code-actions-builder.js';
import getDocumentConfig from './get-document-config.js';
import getDocumentFixes from './get-document-fixes.js';
import getDocumentFolder from './get-document-folder';
import getLintResults from './get-lint-results.js';
import {lintDocument, lintDocuments} from './lint-document.js';
import {log, logError} from './logger';
import resolveXo from './resolve-xo';

// eslint-disable-next-line @typescript-eslint/naming-convention
const DEFAULT_DEBOUNCE = 0;

interface ChangeConfigurationParams extends DidChangeConfigurationParams {
	settings: {xo: XoConfig};
}

class LintServer {
	readonly connection: Connection;
	readonly documents: TextDocuments<TextDocument>;
	readonly queue: Queue;
	log: typeof log;
	logError: typeof logError;
	getDocumentConfig: typeof getDocumentConfig;
	getDocumentFixes: typeof getDocumentFixes;
	getDocumentFolder: typeof getDocumentFolder;
	getLintResults: typeof getLintResults;
	lintDocument: typeof lintDocument;
	lintDocumentDebounced: DebouncedFunc<typeof lintDocument>;
	lintDocuments: typeof lintDocuments;
	resolveXo: typeof resolveXo;
	foldersCache: Map<string, Partial<TextDocument>>;
	configurationCache: Map<string, XoConfig>;
	xoCache: Map<string, Xo>;
	documentFixes: Map<string, Map<string, XoFix>>;

	hasShownResolutionError: boolean;
	currentDebounce: number;

	constructor() {
		/**
		 * Bind all imported methods
		 */
		this.getDocumentConfig = getDocumentConfig.bind(this);

		this.getDocumentFixes = getDocumentFixes.bind(this);

		this.getDocumentFolder = getDocumentFolder.bind(this);

		this.getLintResults = getLintResults.bind(this);

		this.lintDocument = lintDocument.bind(this);

		this.lintDocuments = lintDocuments.bind(this);

		this.lintDocumentDebounced = debounce(this.lintDocument, DEFAULT_DEBOUNCE, {
			maxWait: 350
		});

		this.resolveXo = resolveXo.bind(this);

		this.log = log.bind(this);
		this.logError = logError.bind(this);

		/**
		 * Bind all methods
		 */
		autoBind(this);

		/**
		 * Connection
		 */
		this.connection = createConnection(ProposedFeatures.all);

		/**
		 * Documents
		 */
		this.documents = new TextDocuments(TextDocument);

		/**
		 * A message queue which allows for async cancellations and
		 * processing notifications and requests in order
		 */
		this.queue = new Queue({concurrency: 1, autostart: true});

		/**
		 * setup documents listeners
		 */
		this.documents.onDidChangeContent(this.handleDocumentsOnDidChangeContent);
		this.documents.onDidClose(this.handleDocumentsOnDidClose);

		/**
		 * setup connection listeners
		 */
		this.connection.onInitialize(this.handleInitialize);

		/**
		 * handle workspace and xo configuration changes
		 */
		this.connection.onDidChangeConfiguration(this.handleDidChangeConfiguration);
		this.connection.onDidChangeWatchedFiles(this.handleDidChangeWatchedFiles);

		/**
		 * handle document formatting requests
		 * - the built in "allFixes" request does not depend on configuration
		 * - the formatting request requires user to enable xo as formatter
		 */
		this.connection.onRequest(
			new RequestType('textDocument/xo/allFixes').method,
			this.handleAllFixesRequest
		);
		this.connection.onDocumentFormatting(this.handleDocumentFormattingRequest);
		this.connection.onCodeAction(this.handleCodeActionRequest);

		/**
		 * A mapping of folderPaths to the resolved XO module
		 */
		this.xoCache = new Map();

		/**
		 * A mapping of folderPaths to configuration options
		 */
		this.configurationCache = new Map();

		/**
		 * A mapping of folders to the location of their package.json
		 */
		this.foldersCache = new Map();

		/**
		 * A mapping of document uri strings to their last calculated fixes
		 */
		this.documentFixes = new Map();

		this.hasShownResolutionError = false;
		this.currentDebounce = DEFAULT_DEBOUNCE;
	}

	listen() {
		// Listen for text document create, change
		this.documents.listen(this.connection);
		this.connection.listen();
		this.connection.console.info(`XO Server Starting in Node ${process.version}`);
	}

	/**
	 * check if document is open
	 *
	 */
	isDocumentOpen(document: TextDocument | TextDocumentIdentifier): boolean {
		return Boolean(document?.uri && this.documents.get(document.uri));
	}

	/**
	 * handle connection.onInitialize
	 */
	async handleInitialize(): Promise<InitializeResult> {
		return {
			capabilities: {
				workspace: {
					workspaceFolders: {
						supported: true
					}
				},
				textDocumentSync: {
					openClose: true,
					change: TextDocumentSyncKind.Incremental
				},
				documentFormattingProvider: true,
				codeActionProvider: true
			}
		};
	}

	/**
	 * Handle connection.onDidChangeConfiguration
	 */
	async handleDidChangeConfiguration(params: ChangeConfigurationParams) {
		if (
			Number.isInteger(Number(params?.settings?.xo?.debounce)) &&
			Number(params?.settings?.xo?.debounce) !== this.currentDebounce
		) {
			this.currentDebounce = params.settings.xo.debounce ?? 0;
			this.lintDocumentDebounced = debounce(this.lintDocument, params.settings.xo.debounce, {
				maxWait: 350
			});
		}

		// recache each folder config
		this.configurationCache.clear();
		return this.lintDocuments(this.documents.all());
	}

	/**
	 * handle connection.onDidChangeWatchedFiles
	 */
	async handleDidChangeWatchedFiles() {
		return this.lintDocuments(this.documents.all());
	}

	/**
	 * Handle custom all fixes request
	 */
	async handleAllFixesRequest(params: {
		textDocument: TextDocumentIdentifier;
	}): Promise<DocumentFixes | void> {
		return new Promise((resolve, reject) => {
			this.queue.push(async () => {
				try {
					const fixes = await this.getDocumentFixes(params.textDocument.uri);
					if (isUndefined(fixes)) {
						resolve();
						return;
					}

					resolve(fixes);
				} catch (error: unknown) {
					reject(error);
				}
			});
		});
	}

	/**
	 * Handle LSP document formatting request
	 */
	async handleDocumentFormattingRequest(
		params: DocumentFormattingParams,
		token: CancellationToken
	): Promise<TextEdit[]> {
		return new Promise((resolve, reject) => {
			this.queue.push(async () => {
				try {
					if (!this.isDocumentOpen(params.textDocument)) return;

					if (token.isCancellationRequested) {
						reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request was cancelled'));
						return;
					}

					const cachedTextDocument = this.documents.get(params.textDocument.uri);

					if (typeof cachedTextDocument === 'undefined') {
						resolve([]);
						return;
					}

					const config = await this.getDocumentConfig(params.textDocument);

					if (typeof config === 'undefined' || !config?.format?.enable) {
						resolve([]);
						return;
					}

					// get fixes and send to client
					const fixes = await this.getDocumentFixes(params.textDocument.uri);

					if (!fixes?.edits) {
						resolve([]);
						return;
					}

					const originalText = cachedTextDocument.getText();

					// clone the cached document
					const textDocument = TextDocument.create(
						cachedTextDocument.uri,
						cachedTextDocument.languageId,
						cachedTextDocument.version,
						originalText
					);

					// apply the edits to the copy and get the edits that would be
					// further needed for all the fixes to work.
					const editedContent = TextDocument.applyEdits(textDocument, fixes.edits);

					const report = await this.getLintResults(textDocument, editedContent, true);

					if (report.results[0].output && report.results[0].output !== editedContent) {
						this.log('Experimental replace triggered');
						const string0 = originalText;
						const string1 = report.results[0].output;

						let i = 0;
						while (i < string0.length && i < string1.length && string0[i] === string1[i]) {
							++i;
						}

						// length of common suffix
						let j = 0;
						while (
							i + j < string0.length &&
							i + j < string1.length &&
							string0[string0.length - j - 1] === string1[string1.length - j - 1]
						) {
							++j;
						}

						// eslint-disable-next-line unicorn/prefer-string-slice
						const newText = string1.substring(i, string1.length - j);
						const pos0 = cachedTextDocument.positionAt(i);
						const pos1 = cachedTextDocument.positionAt(string0.length - j);

						resolve([TextEdit.replace(Range.create(pos0, pos1), newText)]);
						return;
					}

					resolve(fixes?.edits);
				} catch (error: unknown) {
					if (error instanceof Error) {
						this.logError(error);
					}

					reject(error);
				}
			});
		});
	}

	/**
	 * Handle LSP code action request
	 * these happen at the time of an error/warning hover
	 */
	async handleCodeActionRequest(
		params: CodeActionParams,
		token: CancellationToken
	): Promise<CodeAction[]> {
		return new Promise((resolve, reject) => {
			this.queue.push(async () => {
				try {
					if (!params.context?.diagnostics?.length) {
						resolve([]);
						return;
					}

					if (!params?.textDocument?.uri) {
						resolve([]);
						return;
					}

					if (token.isCancellationRequested) {
						reject(new ResponseError(LSPErrorCodes.RequestCancelled, 'Request got cancelled'));
						return;
					}

					const [diagnostic] = params.context.diagnostics;
					const documentEdits = this.documentFixes.get(params.textDocument.uri);
					const textDocument = this.documents.get(params.textDocument.uri);
					const edit = documentEdits?.get(utils.computeKey(diagnostic));

					if (isUndefined(edit) || isUndefined(textDocument)) {
						resolve([]);
						return;
					}

					const codeActionBuilder = new CodeActionsBuilder({
						diagnostic,
						edit,
						textDocument
					});

					resolve(codeActionBuilder.build());
				} catch (error: unknown) {
					if (error instanceof Error) this.logError(error);
					reject(error);
				}
			});
		});
	}

	/**
	 * Handle documents.onDidChangeContent
	 * queues document content linting
	 * @param {import('vscode-languageserver/node').TextDocumentChangeEvent} event
	 */
	handleDocumentsOnDidChangeContent(event: TextDocumentChangeEvent<TextDocument>) {
		this.queue.push(async () => {
			try {
				if (event.document.version !== this.documents.get(event.document.uri)?.version) return;

				await this.lintDocumentDebounced(event.document);
			} catch (error: unknown) {
				if (error instanceof Error) this.logError(error);
			}
		});
	}

	/**
	 * Handle documents.onDidClose
	 * Clears the diagnostics when document is closed and
	 * cleans up cached folders that no longer have open documents
	 */
	async handleDocumentsOnDidClose(event: TextDocumentChangeEvent<TextDocument>): Promise<void> {
		const folders = new Set(
			[...this.documents.all()].map((document) => path.dirname(document.uri))
		);

		for (const folder of this.foldersCache.keys()) {
			if (!folders.has(folder)) {
				this.foldersCache.delete(folder);
				this.xoCache.delete(folder);
				this.configurationCache.delete(folder);
			}
		}

		await this.connection.sendDiagnostics({
			uri: event.document.uri.toString(),
			diagnostics: []
		});
	}
}

new LintServer().listen();

export default LintServer;