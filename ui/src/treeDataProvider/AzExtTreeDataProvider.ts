/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, EventEmitter, TreeItem } from 'vscode';
import * as types from '../../index';
import { callWithTelemetryAndErrorHandling } from '../callWithTelemetryAndErrorHandling';
import { UserCancelledError } from '../errors';
import { localize } from '../localize';
import { parseError } from '../parseError';
import { nonNullProp } from '../utils/nonNull';
import { AzureWizard } from '../wizard/AzureWizard';
import { AzExtParentTreeItem } from './AzExtParentTreeItem';
import { AzExtTreeItem } from './AzExtTreeItem';
import { GenericTreeItem } from './GenericTreeItem';
import { getThemedIconPath } from './IconPath';
import { IAzExtTreeDataProviderInternal, isAzExtParentTreeItem } from './InternalInterfaces';
import { runWithLoadingNotification } from './runWithLoadingNotification';
import { loadMoreLabel } from './treeConstants';
import { TreeItemListStep } from './TreeItemListStep';

export class AzExtTreeDataProvider implements IAzExtTreeDataProviderInternal, types.AzExtTreeDataProvider {
    public _onTreeItemCreateEmitter: EventEmitter<AzExtTreeItem> = new EventEmitter<AzExtTreeItem>();
    private _onDidChangeTreeDataEmitter: EventEmitter<AzExtTreeItem> = new EventEmitter<AzExtTreeItem>();

    private readonly _loadMoreCommandId: string;
    private readonly _rootTreeItem: AzExtParentTreeItem;
    private readonly _findTreeItemTasks: Map<string, Promise<types.AzExtTreeItem | undefined>> = new Map();

    constructor(rootTreeItem: AzExtParentTreeItem, loadMoreCommandId: string) {
        this._loadMoreCommandId = loadMoreCommandId;
        this._rootTreeItem = rootTreeItem;
        rootTreeItem.treeDataProvider = <IAzExtTreeDataProviderInternal>this;
    }

    public get onDidChangeTreeData(): Event<AzExtTreeItem> {
        return this._onDidChangeTreeDataEmitter.event;
    }

    public get onTreeItemCreate(): Event<AzExtTreeItem> {
        return this._onTreeItemCreateEmitter.event;
    }

    public getTreeItem(treeItem: AzExtTreeItem): TreeItem {
        return {
            label: treeItem.effectiveLabel,
            id: treeItem.fullId,
            collapsibleState: treeItem.collapsibleState,
            contextValue: treeItem.effectiveContextValue,
            iconPath: treeItem.effectiveIconPath,
            command: treeItem.commandId ? {
                command: treeItem.commandId,
                title: '',
                // tslint:disable-next-line: strict-boolean-expressions
                arguments: treeItem.commandArgs || [treeItem]
            } : undefined
        };
    }

    public async getChildren(treeItem?: AzExtParentTreeItem): Promise<AzExtTreeItem[]> {
        try {
            return <AzExtTreeItem[]>await callWithTelemetryAndErrorHandling('AzureTreeDataProvider.getChildren', async (context: types.IActionContext) => {
                context.errorHandling.suppressDisplay = true;
                context.errorHandling.rethrow = true;
                let result: AzExtTreeItem[];

                if (!treeItem) {
                    context.telemetry.properties.isActivationEvent = 'true';
                    treeItem = this._rootTreeItem;
                }

                context.telemetry.properties.contextValue = treeItem.effectiveContextValue;

                const cachedChildren: AzExtTreeItem[] = await treeItem.getCachedChildren(context);
                const hasMoreChildren: boolean = treeItem.hasMoreChildrenImpl();
                context.telemetry.properties.hasMoreChildren = String(hasMoreChildren);

                result = treeItem.creatingTreeItems.concat(cachedChildren);
                if (hasMoreChildren && !treeItem._isLoadingMore) {
                    const loadMoreTI: GenericTreeItem = new GenericTreeItem(treeItem, {
                        label: loadMoreLabel,
                        iconPath: getThemedIconPath('refresh'),
                        contextValue: 'azureextensionui.loadMore',
                        commandId: this._loadMoreCommandId
                    });
                    loadMoreTI.commandArgs = [treeItem];
                    result.push(loadMoreTI);
                }

                context.telemetry.measurements.childCount = result.length;
                return result;
            });
        } catch (error) {
            return [new GenericTreeItem(treeItem, {
                label: localize('errorTreeItem', 'Error: {0}', parseError(error).message),
                contextValue: 'azureextensionui.error'
            })];
        }
    }

    public async refresh(treeItem?: AzExtTreeItem): Promise<void> {
        // tslint:disable-next-line: strict-boolean-expressions
        treeItem = treeItem || this._rootTreeItem;

        if (treeItem.refreshImpl) {
            await treeItem.refreshImpl();
        }

        if (isAzExtParentTreeItem(treeItem)) {
            (<AzExtParentTreeItem>treeItem).clearCache();
        }

        this.refreshUIOnly(treeItem);
    }

    public refreshUIOnly(_treeItem: AzExtTreeItem | undefined): void {
        // Pass undefined as temporary workaround for https://github.com/microsoft/vscode/issues/71698
        this._onDidChangeTreeDataEmitter.fire(undefined);
        // this._onDidChangeTreeDataEmitter.fire(treeItem === this._rootTreeItem ? undefined : treeItem);
    }

    public async loadMore(treeItem: AzExtParentTreeItem, context: types.IActionContext): Promise<void> {
        await treeItem.loadMoreChildren(context);
    }

    public async showTreeItemWizard<T extends types.AzExtTreeItem>(expectedContextValue: types.IExpectedContextValue | string, context: types.ITreeItemActionContext & { canPickMany: true }, startingTreeItem?: AzExtParentTreeItem): Promise<T[]>;
    public async showTreeItemWizard<T extends types.AzExtTreeItem>(expectedContextValue: types.IExpectedContextValue | string, context: types.ITreeItemActionContext, startingTreeItem?: AzExtParentTreeItem): Promise<T>;
    public async showTreeItemWizard<T extends types.AzExtTreeItem>(expectedContextValue: types.IExpectedContextValue | string, context: types.ITreeItemActionContext, startingTreeItem?: AzExtParentTreeItem): Promise<T | T[]> {
        if (typeof expectedContextValue === 'string') {
            expectedContextValue = {
                id: expectedContextValue
            };
        }

        const wizardContext: types.ITreeItemWizardContext = context;
        if (startingTreeItem?.matchesContextValue(expectedContextValue)) {
            wizardContext.pickedTreeItem = startingTreeItem;
        }

        const wizard: AzureWizard<types.ITreeItemWizardContext> = new AzureWizard(wizardContext, {
            // tslint:disable-next-line:strict-boolean-expressions
            promptSteps: [new TreeItemListStep(startingTreeItem || this._rootTreeItem, expectedContextValue)]
        });

        await wizard.prompt();

        if (wizardContext.action === 'createChild' || wizardContext.action === 'createChildAdvanced') {
            const parent: AzExtParentTreeItem = <AzExtParentTreeItem>nonNullProp(wizardContext, 'pickedTreeItem'); // todo cast
            const label: string = nonNullProp(wizardContext, 'newChildLabel');
            await parent.withCreateProgress(label, async (): Promise<types.AzExtTreeItem> => {
                await wizard.execute();
                return nonNullProp(wizardContext, 'newChildTreeItem');
            });
        } else {
            await wizard.execute();
        }

        return <T><unknown>nonNullProp(wizardContext, 'pickedTreeItem');
    }

    public initTreeCommand(expectedContextValue: types.IExpectedContextValue | string, action: types.TreeItemWizardAction): types.CommandCallback {
        return async (context: types.IActionContext & Partial<types.ITreeItemWizardContext>, treeItem?: AzExtTreeItem): Promise<unknown> => {
            context.action = action;
            context.pickedTreeItem = treeItem;
            return await this.showTreeItemWizard(expectedContextValue, context);
        };
    }

    public async getParent(treeItem: AzExtTreeItem): Promise<AzExtTreeItem | undefined> {
        return treeItem.parent === this._rootTreeItem ? undefined : treeItem.parent;
    }

    public async findTreeItem<T extends types.AzExtTreeItem>(fullId: string, context: types.IFindTreeItemContext): Promise<T | undefined> {
        let result: types.AzExtTreeItem | undefined;

        const existingTask: Promise<types.AzExtTreeItem | undefined> | undefined = this._findTreeItemTasks.get(fullId);
        if (existingTask) {
            result = await existingTask;
        } else {
            const newTask: Promise<types.AzExtTreeItem | undefined> = this.findTreeItemInternal(fullId, context);
            this._findTreeItemTasks.set(fullId, newTask);
            try {
                result = await newTask;
            } finally {
                this._findTreeItemTasks.delete(fullId);
            }
        }

        return <T><unknown>result;
    }

    /**
     * Wrapped by `findTreeItem` to ensure only one find is happening per `fullId` at a time
     */
    private async findTreeItemInternal(fullId: string, context: types.IFindTreeItemContext): Promise<types.AzExtTreeItem | undefined> {
        let treeItem: AzExtParentTreeItem = this._rootTreeItem;
        return await runWithLoadingNotification(context, async (cancellationToken) => {
            // tslint:disable-next-line: no-constant-condition
            outerLoop: while (true) {
                if (cancellationToken.isCancellationRequested) {
                    context.telemetry.properties.cancelStep = 'findTreeItem';
                    throw new UserCancelledError();
                }

                const children: AzExtTreeItem[] = await treeItem.getCachedChildren(context);
                for (const child of children) {
                    if (child.fullId === fullId) {
                        return child;
                    } else if (isAncestor(child, fullId)) {
                        treeItem = <AzExtParentTreeItem>child;
                        continue outerLoop;
                    }
                }

                if (context.loadAll && treeItem.hasMoreChildrenImpl()) {
                    await treeItem.loadMoreChildren(context);
                } else {
                    return undefined;
                }
            }
        });
    }
}

function isAncestor(treeItem: AzExtTreeItem, fullId: string): boolean {
    // Append '/' to 'treeItem.fullId' when checking 'startsWith' to ensure its actually an ancestor, rather than a treeItem at the same level that _happens_ to start with the same id
    // For example, two databases named 'test' and 'test1' as described in this issue: https://github.com/Microsoft/vscode-cosmosdb/issues/488
    return fullId.startsWith(`${treeItem.fullId}/`) && isAzExtParentTreeItem(treeItem);
}
