<script lang="ts">
	import { onDestroy } from 'svelte';

	let frequency = $state<number | null>(null);
	let isDetecting = $state(false);
	let error = $state<string | null>(null);

	let audioContext: AudioContext | null = null;
	let analyser: AnalyserNode | null = null;
	let microphone: MediaStreamAudioSourceNode | null = null;
	let highPassFilter: BiquadFilterNode | null = null;
	let stream: MediaStream | null = null;
	let animationFrame: number | null = null;
	let frequencyHistory: number[] = [];

	const MIN_FREQUENCY = 100;
	const MAX_FREQUENCY = 1000;
	const HISTORY_SIZE = 7; // For median filtering

	// High-pass filter to remove drone frequencies (116 Hz and 233 Hz)
	function createHighPassFilter(context: AudioContext): BiquadFilterNode {
		const filter = context.createBiquadFilter();
		filter.type = 'highpass';
		filter.frequency.value = 350; // Above drone frequencies
		filter.Q.value = 0.7;
		return filter;
	}

	// YIN algorithm - much better for instruments with strong harmonics
	function yinPitchDetection(
		buffer: Float32Array,
		sampleRate: number
	): { frequency: number; confidence: number } {
		const bufferSize = buffer.length;
		const threshold = 0.15;
		const minPeriod = Math.floor(sampleRate / MAX_FREQUENCY);
		const maxPeriod = Math.floor(sampleRate / MIN_FREQUENCY);

		// Step 1: Calculate difference function
		const differenceFunction = new Float32Array(maxPeriod);
		for (let tau = minPeriod; tau < maxPeriod; tau++) {
			let sum = 0;
			for (let i = 0; i < bufferSize - maxPeriod; i++) {
				const delta = buffer[i] - buffer[i + tau];
				sum += delta * delta;
			}
			differenceFunction[tau] = sum;
		}

		// Step 2: Cumulative mean normalized difference
		const cmndf = new Float32Array(maxPeriod);
		cmndf[0] = 1;
		let runningSum = 0;
		for (let tau = 1; tau < maxPeriod; tau++) {
			runningSum += differenceFunction[tau];
			cmndf[tau] = differenceFunction[tau] / (runningSum / tau);
		}

		// Step 3: Find first minimum below threshold
		let tauEstimate = -1;
		for (let tau = minPeriod; tau < maxPeriod; tau++) {
			if (cmndf[tau] < threshold) {
				// Find the local minimum
				while (tau + 1 < maxPeriod && cmndf[tau + 1] < cmndf[tau]) {
					tau++;
				}
				tauEstimate = tau;
				break;
			}
		}

		if (tauEstimate === -1) {
			return { frequency: -1, confidence: 0 };
		}

		// Step 4: Parabolic interpolation for sub-sample accuracy
		let betterTau = tauEstimate;
		if (tauEstimate > 0 && tauEstimate < maxPeriod - 1) {
			const s0 = cmndf[tauEstimate - 1];
			const s1 = cmndf[tauEstimate];
			const s2 = cmndf[tauEstimate + 1];
			betterTau = tauEstimate + (s2 - s0) / (2 * (2 * s1 - s2 - s0));
		}

		const frequency = sampleRate / betterTau;
		const confidence = 1 - cmndf[tauEstimate];

		return { frequency, confidence };
	}

	// Median filter to smooth out jumps
	function getMedianFrequency(): number | null {
		if (frequencyHistory.length === 0) return null;
		const sorted = [...frequencyHistory].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	}

	function detectPitch() {
		if (!analyser || !audioContext) return;

		const buffer = new Float32Array(analyser.fftSize);
		analyser.getFloatTimeDomainData(buffer);

		// Calculate RMS to ensure there's signal
		let rms = 0;
		for (let i = 0; i < buffer.length; i++) {
			rms += buffer[i] * buffer[i];
		}
		rms = Math.sqrt(rms / buffer.length);

		// Only process if there's enough signal
		if (rms > 0.01) {
			const result = yinPitchDetection(buffer, audioContext.sampleRate);

			// Only accept high-confidence detections in the correct range
			if (
				result.confidence > 0.92 &&
				result.frequency >= MIN_FREQUENCY &&
				result.frequency <= MAX_FREQUENCY
			) {
				// Add to history for median filtering
				frequencyHistory.push(result.frequency);
				if (frequencyHistory.length > HISTORY_SIZE) {
					frequencyHistory.shift();
				}

				// Update displayed frequency with median of recent detections
				const median = getMedianFrequency();
				if (median !== null) {
					frequency = Math.round(median * 10) / 10;
				}
			}
		}

		animationFrame = requestAnimationFrame(detectPitch);
	}

	async function startDetection() {
		try {
			error = null;
			frequencyHistory = [];
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });

			audioContext = new AudioContext();
			analyser = audioContext.createAnalyser();
			analyser.fftSize = 8192; // Larger buffer for better frequency resolution
			analyser.smoothingTimeConstant = 0.3;

			// Create high-pass filter to remove drone frequencies
			highPassFilter = createHighPassFilter(audioContext);

			microphone = audioContext.createMediaStreamSource(stream);

			// Connect: microphone -> high-pass filter -> analyser
			microphone.connect(highPassFilter);
			highPassFilter.connect(analyser);

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

		if (highPassFilter) {
			highPassFilter.disconnect();
			highPassFilter = null;
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
		frequencyHistory = [];
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
