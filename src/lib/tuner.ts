const MIN_FREQUENCY = 100;
const MAX_FREQUENCY = 1000;
const HISTORY_SIZE = 7; // For median filtering

type FrequencyCallback = (frequency: number | null) => void;

export class Tuner {
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private microphone: MediaStreamAudioSourceNode | null = null;
	private highPassFilter: BiquadFilterNode | null = null;
	private stream: MediaStream | null = null;
	private animationFrame: number | null = null;
	private frequencyHistory: number[] = [];
	private onFrequencyUpdate: FrequencyCallback | null = null;

	constructor(onFrequencyUpdate: FrequencyCallback) {
		this.onFrequencyUpdate = onFrequencyUpdate;
	}

	// High-pass filter to remove drone frequencies (116 Hz and 233 Hz)
	private createHighPassFilter(context: AudioContext): BiquadFilterNode {
		const filter = context.createBiquadFilter();
		filter.type = 'highpass';
		filter.frequency.value = 350; // Above drone frequencies
		filter.Q.value = 0.7;
		return filter;
	}

	// YIN algorithm - much better for instruments with strong harmonics
	private yinPitchDetection(
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
	private getMedianFrequency(): number | null {
		if (this.frequencyHistory.length === 0) return null;
		const sorted = [...this.frequencyHistory].sort((a, b) => a - b);
		const mid = Math.floor(sorted.length / 2);
		return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
	}

	private detectPitch = () => {
		if (!this.analyser || !this.audioContext) return;

		const buffer = new Float32Array(this.analyser.fftSize);
		this.analyser.getFloatTimeDomainData(buffer);

		// Calculate RMS to ensure there's signal
		let rms = 0;
		for (let i = 0; i < buffer.length; i++) {
			rms += buffer[i] * buffer[i];
		}
		rms = Math.sqrt(rms / buffer.length);

		// Only process if there's enough signal
		if (rms > 0.01) {
			const result = this.yinPitchDetection(buffer, this.audioContext.sampleRate);

			// Only accept high-confidence detections in the correct range
			if (
				result.confidence > 0.92 &&
				result.frequency >= MIN_FREQUENCY &&
				result.frequency <= MAX_FREQUENCY
			) {
				// Add to history for median filtering
				this.frequencyHistory.push(result.frequency);
				if (this.frequencyHistory.length > HISTORY_SIZE) {
					this.frequencyHistory.shift();
				}

				// Update displayed frequency with median of recent detections
				const median = this.getMedianFrequency();
				if (median !== null && this.onFrequencyUpdate) {
					this.onFrequencyUpdate(Math.round(median * 10) / 10);
				}
			}
		}

		this.animationFrame = requestAnimationFrame(this.detectPitch);
	};

	async start(): Promise<void> {
		this.frequencyHistory = [];
		this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });

		this.audioContext = new AudioContext();
		this.analyser = this.audioContext.createAnalyser();
		this.analyser.fftSize = 8192; // Larger buffer for better frequency resolution
		this.analyser.smoothingTimeConstant = 0.3;

		// Create high-pass filter to remove drone frequencies
		this.highPassFilter = this.createHighPassFilter(this.audioContext);

		this.microphone = this.audioContext.createMediaStreamSource(this.stream);

		// Connect: microphone -> high-pass filter -> analyser
		this.microphone.connect(this.highPassFilter);
		this.highPassFilter.connect(this.analyser);

		this.detectPitch();
	}

	stop(): void {
		if (this.animationFrame) {
			cancelAnimationFrame(this.animationFrame);
			this.animationFrame = null;
		}

		if (this.highPassFilter) {
			this.highPassFilter.disconnect();
			this.highPassFilter = null;
		}

		if (this.microphone) {
			this.microphone.disconnect();
			this.microphone = null;
		}

		if (this.stream) {
			this.stream.getTracks().forEach((track) => track.stop());
			this.stream = null;
		}

		if (this.audioContext) {
			this.audioContext.close();
			this.audioContext = null;
		}

		this.analyser = null;
		this.frequencyHistory = [];

		if (this.onFrequencyUpdate) {
			this.onFrequencyUpdate(null);
		}
	}
}
