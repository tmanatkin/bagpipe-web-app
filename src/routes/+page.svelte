<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	let frequency = $state<number | null>(null);
	let isDetecting = $state(false);
	let error = $state<string | null>(null);

	let audioContext: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let microphone: MediaStreamAudioSourceNode | null = null;
	let stream: MediaStream | null = null;
	let animationFrame: number | null = null;

	function autoCorrelate(buffer: Float32Array, sampleRate: number): number {
		const SIZE = buffer.length;
		const MAX_SAMPLES = Math.floor(SIZE / 2);
		let bestOffset = -1;
		let bestCorrelation = 0;
		let rms = 0;

		// Calculate RMS (root mean square) to detect silence
		for (let i = 0; i < SIZE; i++) {
			const val = buffer[i];
			rms += val * val;
		}
		rms = Math.sqrt(rms / SIZE);

		// Not enough signal
		if (rms < 0.01) return -1;

		// Find the best correlation offset
		let lastCorrelation = 1;
		for (let offset = 1; offset < MAX_SAMPLES; offset++) {
			let correlation = 0;

			for (let i = 0; i < MAX_SAMPLES; i++) {
				correlation += Math.abs(buffer[i] - buffer[i + offset]);
			}

			correlation = 1 - correlation / MAX_SAMPLES;

			if (correlation > 0.9 && correlation > lastCorrelation) {
				const foundOffset = offset;
				if (correlation > bestCorrelation) {
					bestCorrelation = correlation;
					bestOffset = foundOffset;
				}
			}

			lastCorrelation = correlation;
		}

		if (bestOffset > -1) {
			return sampleRate / bestOffset;
		}
		return -1;
	}

	function detectPitch() {
		if (!analyser || !audioContext) return;

		const buffer = new Float32Array(analyser.fftSize);
		analyser.getFloatTimeDomainData(buffer);

		const detectedFreq = autoCorrelate(buffer, audioContext.sampleRate);

		if (detectedFreq > -1) {
			frequency = Math.round(detectedFreq * 10) / 10;
		}

		animationFrame = requestAnimationFrame(detectPitch);
	}

	async function startDetection() {
		try {
			error = null;
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });

			audioContext = new AudioContext();
			analyser = audioContext.createAnalyser();
			analyser.fftSize = 2048;
			analyser.smoothingTimeConstant = 0.8;

			microphone = audioContext.createMediaStreamSource(stream);
			microphone.connect(analyser);

			isDetecting = true;
			detectPitch();
		} catch (err) {
			error = 'Failed to access microphone. Please grant permission.';
			console.error(err);
		}
	}

	function stopDetection() {
		if (animationFrame) {
			cancelAnimationFrame(animationFrame);
			animationFrame = null;
		}

		if (microphone) {
			microphone.disconnect();
			microphone = null;
		}

		if (stream) {
			stream.getTracks().forEach((track) => track.stop());
			stream = null;
		}

		if (audioContext) {
			audioContext.close();
			audioContext = null;
		}

		analyser = null;
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
	<p class="error" style="visibility: {error ? 'visible' : 'hidden'}">{error}</p>

	<h1>Bagpipe Tuner</h1>

	{#if !isDetecting}
		<button onclick={startDetection}>Start Detection</button>
	{:else}
		<button onclick={stopDetection}>Stop Detection</button>
	{/if}

	<div class="frequency-display" class:inactive={!isDetecting}>
		<span class="frequency">{formatFrequency(frequency)}</span>
		<span class="unit">Hz</span>
	</div>
</main>
x
