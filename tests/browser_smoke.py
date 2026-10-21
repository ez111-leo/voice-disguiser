"""Real Web Audio checks with generated input and a fake microphone."""
import io
import math
import os
import struct
import threading
import wave
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]

def fixture():
    out = io.BytesIO()
    with wave.open(out, 'wb') as wav:
        wav.setparams((2, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b''.join(struct.pack('<hh', int(12000*math.sin(2*math.pi*180*i/16000)), int(8000*math.sin(2*math.pi*270*i/16000))) for i in range(32000)))
    return out.getvalue()

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

def main():
    evidence = Path(os.environ['EVIDENCE_DIR']) if os.environ.get('EVIDENCE_DIR') else None
    if evidence:
        evidence.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            options = dict(headless=True, args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'])
            if os.environ.get('BROWSER_EXECUTABLE'):
                options['executable_path'] = os.environ['BROWSER_EXECUTABLE']
            browser = p.chromium.launch(**options)
            try:
                context = browser.new_context(permissions=['microphone'], viewport={'width':1280, 'height':900})
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                base = f'http://127.0.0.1:{server.server_port}'
                page.route('**/*', lambda route: route.continue_() if route.request.url.startswith(base+'/') else route.abort())
                page.goto(base, wait_until='networkidle')
                page.wait_for_function('STATE.processedBuffer && !STATE.isProcessing', timeout=60000)
                print('PASS initial demo completes', flush=True)

                # Verify actual browser filter behavior, rather than a mock graph.
                response = page.evaluate('''async () => {
                  const b=STATE.audioCtx.createBuffer(2,8000,16000);
                  for(let i=0;i<b.length;i++){
                    b.getChannelData(0)[i]=.3*Math.sin(2*Math.PI*20*i/16000);
                    b.getChannelData(1)[i]=.3*Math.sin(2*Math.PI*800*i/16000);
                  }
                  STATE.originalBuffer=b;STATE.filterEnabled=true;await processAudio();
                  const rms=d=>Math.sqrt(d.slice(1600).reduce((a,x)=>a+x*x,0)/(d.length-1600));
                  return [0,1].map(c=>rms(STATE.filteredBuffer.getChannelData(c))/rms(b.getChannelData(c)));
                }''')
                assert response[0] < .2 and .8 < response[1] < 1.2, response
                print('PASS real bandpass attenuation and passband', flush=True)

                page.locator('#fileInput').set_input_files({'name':'stereo.wav','mimeType':'audio/wav','buffer':fixture()})
                page.wait_for_function('STATE.originalBuffer && STATE.originalBuffer.numberOfChannels===2 && !STATE.isLoading && !STATE.isProcessing')
                result = page.evaluate('({channels:STATE.processedBuffer.numberOfChannels,length:STATE.processedBuffer.length,original:STATE.originalBuffer.length,finite:STATE.processedBuffer.getChannelData(0).every(Number.isFinite)})')
                assert result['channels']==2 and result['length']==result['original'] and result['finite'], result
                print('PASS stereo upload and conversion', flush=True)

                page.locator('#btnFilterOff').click()
                page.wait_for_function('!STATE.isProcessing')
                assert page.evaluate('STATE.filteredBuffer===STATE.originalBuffer')
                page.evaluate("document.querySelector('[data-mode=m2c]').click();document.querySelector('[data-mode=f2m]').click();document.querySelector('[data-mode=f2c]').click()")
                page.wait_for_function('!STATE.isProcessing')
                assert page.evaluate('STATE.modeAlpha===1.5 && STATE.processedBuffer.length===STATE.originalBuffer.length')
                print('PASS bypass and rapid preset changes', flush=True)

                mode = page.locator('[data-mode="f2m"]')
                mode.focus()
                page.keyboard.press('Enter')
                page.wait_for_function('!STATE.isProcessing')
                assert mode.get_attribute('aria-pressed')=='true'
                page.locator('#theoryToggle').focus()
                page.keyboard.press('Space')
                assert page.locator('#theoryToggle').get_attribute('aria-expanded')=='true'
                print('PASS keyboard controls and announced selection', flush=True)

                page.locator('#btnPlayChanged').click()
                page.wait_for_function('STATE.audioCtx.state==="running" && STATE.playingSources.length===1')
                page.locator('[data-speed="0.6"]').click()
                assert page.evaluate('STATE.currentSpeed===0.6 && STATE.playingSources[0].playbackRate.value < 0.61')
                page.locator('#btnStop').click()
                with page.expect_download() as download_info:
                    page.locator('#btnDownload').click()
                download = download_info.value
                with wave.open(str(download.path()), 'rb') as wav:
                    assert wav.getnchannels()==2 and wav.getsampwidth()==2
                    assert wav.getnframes()==page.evaluate('STATE.processedBuffer.length')
                if evidence:
                    download.save_as(evidence / 'stereo-export.wav')
                    page.screenshot(path=str(evidence / 'desktop.png'))
                print('PASS playback, speed and stereo WAV export', flush=True)

                page.locator('#btnRecord').click()
                page.wait_for_function('STATE.isRecording && STATE.recordingAnalyser')
                page.wait_for_function('(()=>{const d=new Float32Array(2048);STATE.recordingAnalyser.getFloatTimeDomainData(d);return d.some(x=>Math.abs(x)>0.001)})()')
                page.locator('#btnStopRecord').click()
                page.wait_for_function('!STATE.isRecording && !STATE.isLoading && !STATE.isProcessing && STATE.processedBuffer')
                assert page.evaluate('STATE.mediaRecorder.stream.getTracks().every(t=>t.readyState==="ended") && STATE.microphoneSource===null')
                print('PASS fake microphone visualization, decoding and track cleanup', flush=True)

                page.set_viewport_size({'width':375,'height':812})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile layout overflows horizontally'
                page.locator('#btnDownload').scroll_into_view_if_needed()
                if evidence:
                    page.screenshot(path=str(evidence / 'mobile.png'), full_page=True)
                print('PASS mobile layout and reachable controls', flush=True)

                page.locator('#fileInput').set_input_files({'name':'invalid.wav','mimeType':'audio/wav','buffer':b'invalid audio'})
                page.wait_for_function('!STATE.isLoading')
                assert '无法读取音频' in page.locator('#statusText').inner_text()
                assert page.locator('#btnDownload').is_disabled()
                assert not errors, errors
                print('PASS invalid input reports error without stale export or uncaught errors', flush=True)
            except Exception:
                if evidence and 'page' in locals():
                    page.screenshot(path=str(evidence / 'failure.png'), full_page=True)
                raise
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()

if __name__ == '__main__':
    main()
