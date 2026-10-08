/**
 * The client list floor, ported from gen_matrix.FEIN_NAME.
 *
 * The plan was to delete this and read the client list from client_overview,
 * which the tracker sync keeps current. A test against real prod data stopped
 * that: five of these clients cannot be reached from client_overview by fein.
 *
 *     Blackwater Management LLC        not in client_overview at all
 *     Key Remnant Delivery Inc         not in client_overview at all
 *     Prolific Logistics TX LLC        not in client_overview at all
 *     Skyland Delivery Solutions LLC   there as SKDL, fein is NULL
 *     Team Primos LLC                  there as TAPR, fein is NULL
 *
 * Between them they have 56 runs in prod. Dropping this map would have made
 * them vanish from the dashboard, which is the same bug it was meant to fix.
 *
 * So the client list is the UNION of this map and client_overview, and this
 * map is a floor rather than the definition:
 *
 *   - a NEW client needs nothing added here; client_overview picks it up (that
 *     is what brings in 844786770, Your Express Solutions, which has been
 *     invisible on the dashboard for as long as it has had runs)
 *   - this map only ever SHRINKS, as those five get a fein in client_overview
 *   - a name here wins over client_overview's, because these were cleaned by
 *     hand ("Excell Logistics Corp." vs the sheet's "EXCELL LOGISTICS CORP")
 *
 * Sandbox employers are in neither, which is how they stay out.
 */
export const FEIN_NAME: Record<string, string> = {
  '992773412': '55th & 3rd LLC',
  '815416452': '61 Degrees North LLC',
  '844435229': 'A A Huddle LLC',
  '850801688': 'Accelerated Logistics Corp',
  '872277669': 'Always More Logistics',
  '851310274': 'Amazing Home Delivery LLC',
  '852876814': 'Amazing Logistics Inc',
  '993807657': 'Banda Logistics LLC',
  '853642271': 'Beck Logistics LLC',
  '874680378': 'Blackwater Management LLC',
  '842685784': 'BTK RUSH INC',
  '872637160': 'Caravan 12th Corporation',
  '834642224': 'Cat 5 Couriers',
  '851098030': 'CDC Logistics',
  '852661720': 'Chief Delivery LLC',
  '921913091': 'DNI Carriers LLC',
  '932949097': 'Door Desk Deliveries LLC',
  '872098931': 'East West Logistix',
  '842381588': 'Elite On Point Delivery Service Inc',
  '994470285': 'Excell Logistics Corp.',
  '863131339': 'Express Package System Inc',
  '844797201': 'Falcon Express Logistics',
  '853291632': 'Fass Logistics LLC',
  '415303937': 'First Line Logistics',
  '920241570': 'Flash Hub Delivery',
  '842211186': 'Fonguh Delivery Services LLC',
  '851100497': 'Goro Logistical LLC',
  '842170332': 'Hansen Brothers Delivery LLC',
  '871780449': 'Happy Delivery LLC',
  '871375963': 'High Distinction Logistics LLC',
  '873718310': 'InnovDel',
  '393271662': 'J4 Transit & Logistics, LLC',
  '934155347': 'JDW Logistics',
  '920277902': 'JM Parcel Service LLC',
  '843994542': 'KDL LLC',
  '842880458': 'Key Remnant Delivery Inc',
  '993347180': 'Lazo Logistics LLC',
  '992400165': 'Leadership Logistics LLC',
  '993287799': 'Lincoln Log LLC',
  '993176161': 'Majestic Logistix LLC',
  '812040886': 'MARK Logistics LLC',
  '852549586': 'MF Logistics LLC',
  '834191394': 'Mike And Fade Consult LLC',
  '841807903': 'Moses Solutions LLC',
  '333760897': 'North Star Parcel LLC',
  '851764448': 'Northstar Logistics LLC',
  '851633535': 'Outside The Box Logistics LLC',
  '871956135': 'Pria Logistics',
  '850986274': 'Prolific Logistics TX LLC',
  '933092758': 'Remson Deliveries LLC',
  '873534994': 'Secure Transit & Logistics, LLC',
  '414824353': 'Skyland Delivery Solutions LLC',
  '874114615': 'Sparkle Logistics LLC',
  '920720113': 'Spelman Logistics Inc',
  '831384622': 'Stave Delivery LLC',
  '831967561': 'Team Primos LLC',
  '275227237': 'Travel Management Professionals LLC',
  '842278245': 'TRUDELO LLC',
  '333274309': 'Urban Box Logistics LLC',
  '884109370': 'Valuable Logistics Inc',
  '811064737': 'Wheels for Work LLC',
};
