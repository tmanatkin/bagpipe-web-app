<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Tuner } from '$lib/tuner';

	interface NoteInfo {
		note: string;
		frequency: number;
		cents: number;
	}

	let noteInfo = $state<NoteInfo | null>(null);
	let isDetecting = $state(false);
	let error = $state<string | null>(null);

	let tuner: Tuner | null = null;

	async function startDetection() {
		try {
			error = null;
			tuner = new Tuner((info) => {
				noteInfo = info;
			});
			await tuner.start();
			isDetecting = true;
		} catch (err) {
			error = 'Failed to access microphone. Please grant permission.';
			console.error(err);
		}
	}

	function stopDetection() {
		if (tuner) {
			tuner.stop();
			tuner = null;
		}
		isDetecting = false;
		noteInfo = null;
	}

	function getSharpFlatText(cents: number): string {
		if (cents === 0) return 'in tune';
		if (cents > 0) return `${cents} cents sharp`;
		return `${Math.abs(cents)} cents flat`;
	}

	onDestroy(() => {
		stopDetection();
	});
</script>

<main>
	<p class="error">{error}</p>

	<h1>Bagpipe Tuner</h1>

	{#if !isDetecting}
		<button onclick={startDetection}>Start</button>
	{:else}
		<button onclick={stopDetection}>Stop</button>
	{/if}

	<div class="note-display" class:inactive={!isDetecting}>
		{#if noteInfo}
			<div class="note-name">{noteInfo.note}</div>
			<div
				class="note-status"
				class:sharp={noteInfo.cents > 0}
				class:flat={noteInfo.cents < 0}
				class:in-tune={noteInfo.cents === 0}
			>
				{getSharpFlatText(noteInfo.cents)}
			</div>
			<div class="note-frequency">{noteInfo.frequency} Hz</div>
		{:else}
			<div class="note-name">---</div>
			<div class="note-status">listening...</div>
		{/if}
	</div>
</main>
