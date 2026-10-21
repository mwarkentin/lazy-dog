import { readFileSync } from 'node:fs'
import { readConfig, type Config } from '../src/config.js'
import type { PangramResult } from '../src/pangram.js'

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

/** A Config built from inputs, with the action's defaults for everything else. */
export function config(inputs: Record<string, string> = {}): Config {
  return readConfig((name) => inputs[name] ?? '', {})
}

/** A Pangram 4 success response. */
export const SUCCESS: PangramResult = {
  stage: 'STAGE_SUCCESS',
  text: 'AI-assisted passage. Human passage.',
  version: '4.0',
  headline: 'AI Detected',
  prediction: 'We believe that this text is AI-generated.',
  prediction_short: 'AI',
  fraction_ai: 0.78,
  fraction_ai_assisted: 0.05,
  fraction_human: 0.17,
  num_ai_segments: 2,
  num_ai_assisted_segments: 0,
  num_human_segments: 1,
  windows: [
    {
      text: 'This PR introduces a comprehensive update to the consumer configuration.',
      label: 'AI-Generated',
      ai_assistance_score: 0.97,
      confidence: 'High',
      start_index: 0,
      end_index: 73,
      word_count: 10,
      token_length: 14,
      is_humanized: false,
      humanizer_score: 0.02
    },
    {
      text: 'Overall, these changes facilitate more reliable `consumer` behaviour.',
      label: 'AI-Generated',
      ai_assistance_score: 0.91,
      confidence: 'High',
      start_index: 73,
      end_index: 142,
      word_count: 9,
      token_length: 13,
      is_humanized: false,
      humanizer_score: 0.01
    },
    {
      text: 'Applied it to the canary pod by hand.',
      label: 'Human Written',
      ai_assistance_score: 0.03,
      confidence: 'Medium',
      start_index: 142,
      end_index: 179,
      word_count: 8,
      token_length: 10,
      is_humanized: false,
      humanizer_score: 0
    }
  ]
}
