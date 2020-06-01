import dotenv from 'dotenv'
import puppeteer from 'puppeteer'
import fs from 'fs'
dotenv.config()

interface Movement {
    dateExecution: string
    dateValue: string
    description: string
    amount: number
    operation?: string
    establishment?: string
    concept?: string
    refN?: string
}

console.debug('🤖 Headless mode disabled for now, due to technical difficulties')

async function main () {
  const browser = await puppeteer.launch({
    userDataDir: './puppeteer_tmp',
    headless: false, // process.env.NODE_ENV !== 'development',
    args: [
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.61 Safari/537.36'
    ],
    defaultViewport: {
      width: 1920,
      height: 1080
    }
  })
  const page = await browser.newPage()

  try {
    await login()

    // Go to first bank account
    await Promise.all([
      page.click('.product-wrapper.products-cuentas a.product-link.plus'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' })
    ])

    const allMov = await getAllMovementsForYear(new Date().getFullYear())
    fs.writeFileSync('./output.json', JSON.stringify(allMov))
  } catch (err) {
    await throwErrorWithScreenshot(err)
  }

  async function getAllMovementsForYear (year: number) {
    return [
      ...await getAllMovementsForMonth(1, year),
      ...await getAllMovementsForMonth(2, year),
      ...await getAllMovementsForMonth(3, year),
      ...await getAllMovementsForMonth(4, year),
      ...await getAllMovementsForMonth(5, year),
      ...await getAllMovementsForMonth(6, year),
      ...await getAllMovementsForMonth(7, year),
      ...await getAllMovementsForMonth(8, year),
      ...await getAllMovementsForMonth(9, year),
      ...await getAllMovementsForMonth(10, year),
      ...await getAllMovementsForMonth(11, year),
      ...await getAllMovementsForMonth(12, year)
    ]
  }

  async function getAllMovementsForMonth (month: number, year: number) {
    console.debug(`✨ Getting movements for ${month}/${year}`)
    const loadedMonth = await goToMonth()
    if (!loadedMonth) return []

    let shouldContinue = true
    const monthMovements = []
    while (shouldContinue) {
      monthMovements.push(...await getAllVisibleMovements())
      shouldContinue = (await goToNextPage())
    }

    monthMovements.reverse()
    return monthMovements

    async function goToNextPage () {
      const nextPageLink = await page.$('ul.pager li.next a')
      if (!nextPageLink) return false

      await Promise.all([
        nextPageLink.click(),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' })
      ])

      return true
    }

    async function getAllVisibleMovements () {
      // Load all receipts
      const allReceiptLinks = await page.$$('#movements tbody a.table-link.detalles-link')
      for (const link of allReceiptLinks) {
        await link.click()
      }
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 5000 }).catch(() => {})
      await sleep(1000)

      // Get classes for all trs
      const elms = await page.$$('#movements tbody tr')
      const movementsRawTr = await Promise.all(
        elms.map(async (tr) => {
          const classes = await tr.getProperty('className')
            .then((cn) => cn.jsonValue())
            .then((classStr: string) => classStr.split(' '))
          return { tr, classes }
        })
      )
      // Parse list of trs to actual movement tr + detail tr
      const movementsRaw = (await Promise.all(movementsRawTr.map(async (elm, index) => {
        if (elm.classes.includes('detalles')) return false

        if (movementsRawTr[index + 1].classes.includes('detalles')) {
          return {
            elm: elm.tr,
            detailsElm: movementsRawTr[index + 1].tr
          }
        }

        return { elm: elm.tr }
      }))).filter(Boolean)

      // Parse trs to movement object
      const movements = await Promise.all(movementsRaw.map(async (movElm) => {
        if (!movElm) return // TS needs it, doesn't do anything since it's already filtered out
        const tr = movElm.elm
        const detailsTr = movElm.detailsElm
        const rowTds = await tr.$$eval('td', tds => tds.map(td => td.textContent))
        const movement: Movement = {
          dateExecution: rowTds[1],
          dateValue: rowTds[2],
          description: rowTds[3],
          amount: parseFloat(rowTds[4].replace(',', '.')),
          operation: undefined,
          establishment: undefined,
          concept: undefined,
          refN: undefined
        }
        if (detailsTr) {
          const details = await detailsTr.$$eval('dl', dls => dls.map(dl => {
            const title = dl.querySelector('dt').textContent.slice(0, -1)
            const value = dl.querySelector('dd').textContent.trim()
            return { title, value }
          }))
          details.forEach(detail => {
            switch (detail.title) {
              case 'Descripción op.': {
                movement.operation = detail.value
                break
              }
              case 'Establecimiento': {
                movement.establishment = detail.value
                break
              }
              case 'Nº de referencia': {
                movement.refN = detail.value
                break
              }
              case 'Concepto': {
                movement.concept = detail.value
                break
              }
            }
          })
        }

        return movement
      }))

      return (movements)
    }

    async function goToMonth () {
      await page.hover('div.submenu li:nth-child(1) > a')
      await sleep(500)
      await Promise.all([
        page.click('.submenu a[href^="getmovementsaccount.do"]'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' })
      ])

      await sleep(500)
      await page.click('#searcherContainer2 a[data-toggle="collapse"]')
      await sleep(500)
      await page.click('input[value="getAccountMovementsByDate"]')
      await sleep(200)
      await page.select('select[name="monthSelected"]', month.toString())
      await sleep(200)
      await page.select('select[name="yearSelected"]', year.toString())
      await sleep(200)

      await Promise.all([
        page.click('#searcherContainer2 .button-group button.button'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded' })
      ])

      // Check if month loaded correctly
      const movementsTableExists = Boolean(await page.$('#movements table'))
      const alertText = await page.$eval('.section-alert-text', elm => elm.textContent.trim())
      return movementsTableExists && alertText.length === 0
    }
  }

  async function login () {
    console.debug('🤖 Loading login page')
    await page.goto('https://www.triodos.es/es', { waitUntil: 'networkidle0' })

    await Promise.all([
      page.click('a[href="https://banking.triodos.es/triodos-be/login.sec"]'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' })
    ])

    console.debug('🤖 Logging in')
    await sleep(500)
    await page.focus('input[name="j_username"]')
    await sleep(700)
    page.keyboard.type(process.env.TRIODOS_USERNAME)
    await sleep(500)
    await page.focus('input[name="j_password"]')
    await sleep(700)
    page.keyboard.type(process.env.TRIODOS_PASSWORD)
    await sleep(500)

    await Promise.all([
      page.click('button#submitButton'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' })
    ])

    // Check if logged in correctly
    if (!(await page.$('#mainmenu'))) {
      await throwErrorWithScreenshot(new Error('Unable to login'))
    }

    console.debug('🤖 Logged in succesfully!')
  }

  async function throwErrorWithScreenshot (err: Error) {
    await page.screenshot({ path: `error-${Date.now()}.jpg` })
    throw err
  }
}

main().catch(err => {
  console.error(err)
})

function sleep (ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
