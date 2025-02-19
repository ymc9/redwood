import { Assets } from '@redwoodjs/vite/assets'
import { ProdRwRscServerGlobal } from '@redwoodjs/vite/rwRscGlobal'

import { Counter } from './Counter'

import './AboutPage.css'

// TODO (RSC) Something like this will probably be needed
// const RwRscGlobal = import.meta.env.PROD ? ProdRwRscServerGlobal : DevRwRscServerGlobal;

globalThis.rwRscGlobal = new ProdRwRscServerGlobal()

const AboutPage = () => {
  return (
    <div className="about-page">
      {/* TODO (RSC) <Assets /> should be part of the router later */}
      <Assets />
      <div style={{ border: '3px red dashed', margin: '1em', padding: '1em' }}>
        <h1>About Redwood</h1>
        <Counter />
      </div>
    </div>
  )
}

export default AboutPage
