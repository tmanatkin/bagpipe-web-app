const MIN_FREQUENCY = 300;
const MAX_FREQUENCY = 1400;
const HISTORY_SIZE = 7; // For median filtering
const LOW_A_FREQUENCY = 490;

type NoteInfo = {
	note: string;
	frequency: number;
	cents: number; // Positive = sharp, negative = flat
} | null;

type FrequencyCallback = (noteInfo: NoteInfo) => void;

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

	// Bagpipe notes from low A: A, B, C#, D, E, F#, G#, then repeats higher
	private static readonly BAGPIPE_SEMITONES: number[] = [0, 2, 3, 5, 7, 9, 11]; // A, B, C#, D, E, F#, G#
	private static readonly NOTE_OFFSETS: { [key: number]: string } = {
		0: 'A',
		2: 'B',
		3: 'C',
		5: 'D',
		7: 'E',
		9: 'F',
		11: 'G'
	};

	// Calculate which note a frequency corresponds to relative to LOW_A_FREQUENCY
	private getNoteInfo(frequency: number): NoteInfo {
		if (frequency <= 0) return null;

		// Calculate semitones from LOW_A_FREQUENCY
		const semitonesFromLowA = 12 * Math.log2(frequency / LOW_A_FREQUENCY);

		// Find the closest valid bagpipe semitone
		let closestSemitone = Tuner.BAGPIPE_SEMITONES[0];
		let closestDistance = Math.abs(semitonesFromLowA - closestSemitone);

		for (const semitone of Tuner.BAGPIPE_SEMITONES) {
			const distance = Math.abs(semitonesFromLowA - semitone);
			if (distance < closestDistance) {
				closestDistance = distance;
				closestSemitone = semitone;
			}
		}

		// Also check octaves above and below (bagpipes have multiple octaves)
		for (let octave = -2; octave <= 2; octave++) {
			if (octave === 0) continue; // Already checked
			for (const semitone of Tuner.BAGPIPE_SEMITONES) {
				// F# (semitone 9) doesn't exist below low A, only low G
				if (octave < 0 && semitone === 9) continue;

				const octaveSemitone = semitone + octave * 12;
				const distance = Math.abs(semitonesFromLowA - octaveSemitone);
				if (distance < closestDistance) {
					closestDistance = distance;
					closestSemitone = octaveSemitone;
				}
			}
		}

		const centsDeviation = (semitonesFromLowA - closestSemitone) * 100;
		const noteIndex = ((closestSemitone % 12) + 12) % 12;
		const noteName = Tuner.NOTE_OFFSETS[noteIndex];

		if (!noteName) return null;

		// Calculate the target frequency for the closest note
		const targetFrequency = LOW_A_FREQUENCY * Math.pow(2, closestSemitone / 12);

		return {
			note: noteName,
			frequency: Math.round(targetFrequency * 10) / 10,
			cents: Math.round(centsDeviation)
		};
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

			// Check for octave errors: if frequency is low but doubling puts it in bagpipe range, prefer the octave up
			if (result.frequency > 0) {
				const doubledFreq = result.frequency * 2;
				const median = this.getMedianFrequency();

				// If we detect in the 400-650 Hz range (likely octave down), check if octave up is better
				if (result.frequency < 650 && doubledFreq <= MAX_FREQUENCY) {
					// If we have history to compare against, prefer doubling if it's closer to the median
					if (median !== null) {
						const diffOriginal = Math.abs(result.frequency - median);
						const diffDoubled = Math.abs(doubledFreq - median);
						if (diffDoubled < diffOriginal) {
							result.frequency = doubledFreq;
						}
					} else {
						// No history yet - if doubling puts us clearly in bagpipe range, use it
						if (doubledFreq >= 800 && doubledFreq <= MAX_FREQUENCY) {
							result.frequency = doubledFreq;
						}
					}
				}
			}

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
				const medianFreq = this.getMedianFrequency();
				if (medianFreq !== null && this.onFrequencyUpdate) {
					const noteInfo = this.getNoteInfo(medianFreq);
					this.onFrequencyUpdate(noteInfo);
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
