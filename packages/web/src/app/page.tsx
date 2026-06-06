import Link from "next/link";
import { validateRequest } from "@/lib/session";

export default async function Home() {
	const { user } = await validateRequest();

	if (user) {
		const hubInviteUrl = process.env.DISCORD_HUB_INVITE_URL || "#";
		return (
			<main className="flex min-h-screen flex-col items-center justify-center p-8">
				<h1 className="mb-4 text-4xl font-bold">Welcome to Wabi</h1>
				<p className="mb-8 text-lg text-gray-600">Your wellness companion</p>
				<a
					href={hubInviteUrl}
					className="rounded-lg bg-indigo-600 px-6 py-3 text-lg font-semibold text-white hover:bg-indigo-700"
				>
					Start talking to Wabi
				</a>
				<form action="/api/auth/logout" method="POST" className="mt-4">
					<button
						type="submit"
						className="text-sm text-gray-500 underline hover:text-gray-700"
					>
						Log out
					</button>
				</form>
			</main>
		);
	}

	return (
		<main className="flex min-h-screen flex-col items-center justify-center p-8">
			<h1 className="mb-4 text-4xl font-bold">Wabi</h1>
			<p className="mb-8 text-lg text-gray-600">Your wellness companion</p>
			<a
				href="/api/auth/discord"
				className="rounded-lg bg-[#5865F2] px-6 py-3 text-lg font-semibold text-white hover:bg-[#4752C4]"
			>
				Connect Discord
			</a>
		</main>
	);
}
