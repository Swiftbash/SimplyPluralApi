import { randomBytes } from "crypto";
import { readFile } from "fs";
import moment from "moment";
import { promisify } from "util";
import { mailerTransport } from "../../../modules/mail";
import { getCollection } from "../../../modules/mongo";
import * as Sentry from "@sentry/node";
import { auth } from "firebase-admin";
import { assert } from "console";
import { hash } from "./auth.hash";
import { getEmailRegex, revokeAllUserAccess } from "./auth.core";
import { userNotFound } from "../../../modules/messages";
import { logSecurityUserEvent } from "../../../security";

//-------------------------------//
// Generate a new random reset password key
//-------------------------------//
export const getResetPasswordKey = () => randomBytes(64).toString("hex");

//-------------------------------//
// Request password reset link
//-------------------------------//
export const resetPasswordRequest_Execution = async (email: string): Promise<{ success: boolean; msg: string; url: string }> => {
	let resetUrl = "";
	const user = await getCollection("accounts").findOne({ email: getEmailRegex(email) });

	let showSocialLoginInfo = false;

	if (user) {

		if (user.lastResetPasswordEmailSent) {
			const lastTimestamp = user.lastResetPasswordEmailSent;
			if (moment.now() - 1000 * 60 < lastTimestamp) {
				return { success: false, msg: "Request password links can only be requested once every minute", url: "" };
			}
		}

		showSocialLoginInfo = user.oAuth2 === true;

		const resetKey = getResetPasswordKey();

		await getCollection("accounts").updateOne({ email: getEmailRegex(email) }, { $set: { lastResetPasswordEmailSent: moment.now(), passwordResetToken: resetKey } });

		if (process.env.PRETESTING === "true") {
			resetUrl = `https://dist.apparyllis.com/auth/dev/resetpassword.html?key=${resetKey}`;
		} else {
			resetUrl = `https://dist.apparyllis.com/auth/prod/resetpassword.html?key=${resetKey}`;
		}
	} else {
		const firebaseUser = await auth()
			.getUserByEmail(email)
			.catch(() => undefined);
		if (firebaseUser) {
			resetUrl = await auth().generatePasswordResetLink(email);
		} else {
			return { success: false, msg: userNotFound(), url: "" };
		}
	}

	const getFile = promisify(readFile);
	let emailTemplate = await getFile("./templates/resetPasswordEmail.html", "utf-8");

	// This template has the url twice
	emailTemplate = emailTemplate.replace("{{resetUrl}}", resetUrl);
	emailTemplate = emailTemplate.replace("{{resetUrl}}", resetUrl);

	if (showSocialLoginInfo === true) {
		emailTemplate = emailTemplate.replace("{{socialLoginMessage}}", "<p><b>IMPORTANT NOTICE</b>: Your account is logged in with social logins (Google, Apple). If you follow the reset password link and reset your password your social login will be disconnected and you will have to login with password from there on.</p>")
	}
	else {
		emailTemplate = emailTemplate.replace("{{socialLoginMessage}}", "")
	}

	const result: any = await mailerTransport
		?.sendMail({
			from: '"Apparyllis" <noreply@apparyllis.com>',
			to: email,
			html: emailTemplate,
			subject: "Reset your Simply Plural account password",
		})
		.catch(() => {
			null;
		});

	if (result && result.err) {
		Sentry.captureMessage(result.err.toString());
		return { success: false, msg: "Failed to send reset password email, does the email exist?", url: "" };
	}

	return { success: true, msg: "", url: resetUrl };
};

//-------------------------------//
// Reset password execution
//-------------------------------//
export const resetPassword_Exection = async (resetKey: string, newPassword: string): Promise<{ success: boolean; msg: string; uid: string, removedSocialLogin: boolean }> => {
	const user = await getCollection("accounts").findOne({ passwordResetToken: resetKey });
	if (user) {
		assert(resetKey === user.passwordResetToken);

		const lastTimestamp = user.lastResetPasswordEmailSent;
		if (moment.now() > lastTimestamp + 1000 * 60 * 60) {
			await getCollection("accounts").updateOne({ uid: user.uid }, { $unset: { resetKey: "" } });
		}

		const hadSocialLogin = user.oAuth2 === true;

		const salt = randomBytes(16).toString("hex");
		const hashedPasswd = await hash(newPassword, salt);
		await getCollection("accounts").updateOne({ uid: user.uid }, { $set: { password: hashedPasswd.hashed, salt: salt, passwordResetToken: null, oAuth2: false }, $unset: { resetKey: "" } });

		revokeAllUserAccess(user.uid);

		return { success: true, msg: "", uid: user.uid, removedSocialLogin: hadSocialLogin };
	} else {
		return { success: false, msg: "Invalid reset key", uid: "", removedSocialLogin: false };
	}
};
