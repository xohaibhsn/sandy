# Delivery-ops seed notes (`seed-delivery-ops.sql`)

**Owner-only, phpMyAdmin only.** The app never runs this file. Apply **after** migration 0010
(`HOWTO-0010.md`) and after a fresh backup. The file is idempotent (every INSERT is `WHERE NOT EXISTS`) and
has a read-only PRE-CHECK / POST-CHECK. It does **not** touch `site_content`: `shipping_areas_enabled`,
`shipping_restrict_to_zones` and `pickup_enabled` stay OFF.

## What it creates

| Block | Rows | Notes |
| --- | --- | --- |
| Lahore zones | 5 | `Lahore - Lahore City`, `Lahore - Lahore Cantt`, `Lahore - Model Town`, `Lahore - Raiwind`, `Lahore - Shalimar`. Rate / free-shipping minimum / estimate are **copied from the existing active zone named `Lahore`** (if that zone is missing nothing is inserted). No cities / provinces (no overlap with other zones), `delivery_method = 'courier'`, active. |
| Burewala zones | 4 | `Burewala - City`, `Burewala - Surroundings 1`, `Burewala - Surroundings 2`, `Burewala - Surroundings 3`. **Inactive**, rate 0, no free-shipping minimum, no estimate. The owner sets real rates and activates. Zone names match the batch spec (City + Surroundings 1/2/3). Place-to-surroundings grouping under those zones is **DRAFT**. |
| Lahore areas | 5 parents + 110 localities | City `Lahore`. The 5 tehsil parents are pinned to their zone; localities inherit the zone through the parent. |
| Burewala areas | 1 city parent + 6 surrounding places + 12 city localities | City `Burewala`. Surrounding places are pinned to the (inactive) Burewala zones. |
| Pickup points | 2 | `ZZ Test Pickup - Lahore`, `ZZ Test Pickup - Burewala`: active, but customers never see them while `pickup_enabled` is OFF. Address / hours say "TEST ONLY". Delete or replace before enabling pickup. |
| Riders | 0 | None seeded. |

Because every Lahore sub-zone has the **same** rate as `Lahore`, a wrong locality-to-tehsil mapping changes no
price today. It only matters once the owner gives the zones different rates.

## DRAFT / needs owner review (be honest about confidence)

- **Confident:** the five Lahore tehsil names (Lahore City, Lahore Cantonment, Model Town, Raiwind, Shalimar)
  are the five tehsils of Lahore District, and they match the zone names requested.
- **DRAFT (all of it, until the owner has reviewed):** the **locality -> tehsil assignment** for all 110 Lahore
  localities. The list was compiled from general public knowledge of Lahore (towns, housing societies,
  well-known roads / gates / markets). The live web check of the Lahore District page failed (request aborted),
  so no locality was verified line by line against a source. Boundary areas are the most likely to be wrong,
  for example Gulberg, Samanabad, Johar Town / Wapda Town edges, Thokar Niaz Baig, Bahria Town Lahore,
  Shahdara, Jallo, Wagah, Barki / Burki, and DHA phases near the Raiwind Road side.
- **DRAFT:** the 12 **Burewala city localities** (Satellite Town, Model Town, Gulshan-e-Iqbal Colony, Civil Lines,
  Railway Road, Kutchery Road, Multan Road, Vehari Road, Mailsi Road, Pakpattan Road, Ghalla Mandi, Fawara Chowk).
  These are generic names, not checked against a municipal list.
- **Partly sourced:** the Burewala "surroundings" (Gaggo Mandi, Shaikh Fazal, Sahuka, Jamlera, Chak 327/EB, plus
  Dewan Sahib and Kachi Pakki) come from the Wikipedia Burewala page (areas included in the 1976 subdivision,
  places on the Sutlej / near Dewan Sahib). Their grouping into four zones is a **DRAFT** proposal.
- **Spelling:** English transliterations (for example `Gulshan-e-Iqbal`, `Wapda Town`) vary in the wild.
  Edit or deactivate any row in Admin > Shipping > Delivery areas. Deleting an area that orders already
  reference only deactivates it.
- The admin area manager (rename / move / deactivate / bulk add) is the supported way to correct the data;
  re-running this seed never overwrites anything you changed (it only adds missing rows by name).

## Public sources consulted / to cross-check

- Wikipedia, *Burewala* (fetched for this batch): <https://en.wikipedia.org/wiki/Burewala>
- Wikipedia, *Lahore District* (tehsils and towns; the fetch for this batch failed, cross-check manually): <https://en.wikipedia.org/wiki/Lahore_District>
- Wikipedia, *List of neighbourhoods in Lahore* (fetch failed; cross-check manually): <https://en.wikipedia.org/wiki/List_of_neighbourhoods_in_Lahore>
- Punjab Local Government and Community Development Department, tehsil / union council listings (Vehari District:
  Burewala Tehsil): <https://lgcd.punjab.gov.pk>
- Pakistan Bureau of Statistics, tehsil / city population tables (2023 census): <https://www.pbs.gov.pk>
- OpenStreetMap / Google Maps for locality spelling and boundaries (manual spot checks recommended).
- Lahore Development Authority and DHA Lahore public pages for housing-society names and DHA phase numbering.

## How to apply

1. Backup first (see `HOWTO-0010.md`).
2. Select the correct database in phpMyAdmin, confirm the heading names the DATABASE.
3. Run the PRE-CHECK block; make sure one **active** zone named `Lahore` exists (else the Lahore sub-zones are skipped).
4. Import / run the file, then read the POST-CHECK results (riders must be 0, no flag rows or all `0`).
5. Review the data in the admin UI before turning on any flag. Activate the Burewala zones only after setting real rates.
