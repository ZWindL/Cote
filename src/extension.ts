import * as vscode from 'vscode';
import { Cote } from './ui/application';

export async function activate(context: vscode.ExtensionContext) {
  const application = new Cote(context);
  context.subscriptions.push(application);
  await application.ready;
  return application;
}
