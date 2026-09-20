/*---------------------------------------------------------------------------------------------
 *  CloudeIDE
 *--------------------------------------------------------------------------------------------*/

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { CloudeideSignInContribution } from '../browser/cloudeideSignIn.js';

/*
 * The door, before the editor — and only in the desktop app.
 *
 * It lived in the common contribution, which is the file both builds read, so
 * it also appeared to anyone who opened the site in a browser. That is the
 * wrong place for it twice over: the product being sold is the desktop app,
 * and the way back in — cloudeide://auth — is a desktop protocol that a web
 * page has nothing to answer with. A browser tab showing this screen is
 * offering a door that opens onto nothing.
 *
 * BlockRestore rather than AfterRestored: a sign-in screen that fades in a
 * second after the workbench has already painted reads as something that went
 * wrong, not as the way in.
 */
registerWorkbenchContribution2(
	CloudeideSignInContribution.ID,
	CloudeideSignInContribution,
	WorkbenchPhase.BlockRestore,
);
