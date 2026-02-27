<script lang="ts">
	import { onDestroy } from 'svelte';
	import { Tuner } from '$lib/tuner';

	let frequency = $state<number | null>(null);
	let isDetecting = $state(false);
	let error = $state<string | null>(null);

	let tuner: Tuner | null = null;

	async function startDetection() {
		try {
			error = null;
			tuner = new Tuner((freq) => {
				frequency = freq;
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
		frequency = null;
	}

	function formatFrequency(freq: number | null): string {
		if (freq === null) return '---.-';
		if (freq > 999) return '999.9';
		return freq.toFixed(1);
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

	<div class="frequency-display" class:inactive={!isDetecting}>
		<span class="frequency">{formatFrequency(frequency)}</span>
		<span class="unit">Hz</span>
	</div>
</main>
