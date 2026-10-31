// The conference website's own content (/website): what the portal does not
// already know. Taken from the earlier site, nqocn2026.mgims.ac.in.
//
// Everything the portal does know -- the programme, workshops and their
// coordinators, fees and their dates, the abstract deadline, the halls --
// is read live by website.js and is never repeated here.
//
// Photos and logos are under public/website/img; each `photo`/`file` below is
// a path there.

module.exports = {
  // Shown in the footer.
  contactEmail: 'nqocn2026@mgims.ac.in',

  // The venue, for "Open in Google Maps": the New Auditorium Complex.
  venue: {
    name: 'Mahatma Gandhi Institute of Medical Sciences (MGIMS), Sevagram',
    address: 'Sevagram, Wardha, Maharashtra 442102',
    lat: 20.741279, lng: 78.662397,
  },

  host: 'Nationwide Quality of Care Network (NQOCN), India',
  coHost: 'Mahatma Gandhi Institute of Medical Sciences (MGIMS), Sevagram',
  theme: 'Reimagining Quality in Healthcare for a Better Tomorrow',
  copyright: 'Mahatma Gandhi Institute of Medical Sciences, Sevagram',

  about: {
    nqocn: [
      'The Nationwide Quality of Care Network (NQOCN) is a voluntary network formed by teams working on quality improvement initiatives across North, Central, North-East and South India.',
      'It is present in fifteen states, including Delhi, Uttar Pradesh, Haryana, Madhya Pradesh, Maharashtra, Karnataka, Tamil Nadu, Kerala, Rajasthan, Telangana, Meghalaya, Assam, Punjab and Uttarakhand. It has facilitated quality improvement in 131 facilities, which together see about 5,50,000 deliveries a year.',
      'It is a not-for-profit organisation with a flat hierarchy, whose goal is a culture of quality improvement in the health system.',
    ],
    mgims: [
      'Established in 1969, during the Gandhi Centenary year, the Mahatma Gandhi Institute of Medical Sciences (MGIMS), Sevagram, is India\'s first rural medical college. It was founded under the leadership of Dr Sushila Nayar, a close associate of Mahatma Gandhi and a former Union Health Minister, to translate the Gandhian ideals of service, equity and social responsibility into medical education and healthcare.',
      'For over five decades MGIMS has been a pioneer in community-oriented medical education. Its curriculum joins academic excellence with experiential learning through village adoption, community-based training and community service, and its outreach and work with the public health system bridge academic medicine and community needs.',
      'Its teaching hospital, the Kasturba Hospital, is the only hospital in the country started by the Father of the Nation himself. It has grown into a tertiary care centre giving affordable, accessible, compassionate and patient-centred care to rural communities, and the institute\'s research informs clinical practice and public health policy.',
    ],
  },

  internationalFaculty: [
    { name: 'Dr Peter Lachman', role: 'Leadership QI & Patient Safety, Royal College of Physicians of Ireland', photo: 'people/dr-peter-lachman.png' },
    { name: 'Dr Nigel Livesley', role: 'Independent Consultant; former Technical Director, Jhpiego Kenya', photo: 'people/dr-nigel-livesley.png' },
    { name: 'Dr Amit Gupta', role: 'Clinical Lead, NICU, Oxford University Hospitals NHS Trust', photo: 'people/dr-amit-gupta.png' },
  ],

  // The organising team, group by group, as on the earlier site.
  team: [
    { title: 'Chief Patron', people: [['Shri P L Tapdiya', '', 'shri-p-l-tapdiya.png']] },
    { title: 'Patrons', people: [['Dr B S Garg', '', 'dr-b-s-garg.png'], ['Dr A K Shukla', '', 'dr-a-k-shukla.png']] },
    { title: 'Organising Committee', people: [['Dr Vikram Datta', 'Chairman', 'dr-vikram-datta.png'], ['Dr Poonam Varma Shivkumar', 'Co-Chairman', 'dr-poonam-varma-shivkumar.png']] },
    { title: 'Scientific Committee', people: [['Dr Vidyadhar Bangal', 'Chairman', 'dr-vidyadhar-bangal.png'], ['Dr Subodh S Gupta', 'Co-Chairman', 'dr-subodh-s-gupta.png']] },
    { title: 'Organising Secretaries and Treasurer', people: [
      ['Dr Abhishek Raut', 'Organising Secretary', 'dr-abhishek-raut.png'],
      ['Dr Smita Jategaonkar', 'Joint Organising Secretary', 'dr-smita-jategaonkar.png'],
      ['Dr Anuj Mundra', 'Joint Organising Secretary', 'dr-anuj-mundra.png'],
      ['Dr Harshal Sathe', 'Joint Organising Secretary', 'dr-harshal-sathe.png'],
      ['Dr Dipak Das', 'Treasurer', 'dr-dipak-das.png'],
    ] },
    { title: 'Scientific Committee members', people: [
      ['Dr Dilip Gupta', '', 'dr-dilip-gupta.png'], ['Dr Shuchi Jain', '', 'dr-shuchi-jain.png'], ['Dr Manish Jain', '', 'dr-manish-jain.png'],
      ['Dr Chetna Maliye', '', 'dr-chetna-maliye.png'], ['Dr Vijayshri Deotale', '', 'dr-vijayshri-deotale.png'], ['Dr Bharti Taksande', '', 'dr-bharti-taksande.png'],
      ['Dr Ashvini Kalantri', '', 'dr-ashvini-kalantri.png'], ['Dr Arjun Jakasania', '', 'dr-arjun-jakasania.png'], ['Mrs Ancy Ramesh', '', 'mrs-ancy-ramesh.png'],
      ['Mrs Ranjita Wankhede', '', 'mrs-ranjita-wankhede.png'],
    ] },
    { title: 'NQOCN members', people: [
      ['Dr Mahtab Singh', '', 'dr-mahtab-singh.png'], ['Dr Kedar Sawleshwarkar', '', 'dr-kedar-sawleshwarkar.png'], ['Dr Jeena Pradeep', '', 'dr-jeena-pradeep.png'],
      ['Dr Chhaya Valvi', '', 'dr-chhaya-valvi.png'], ['Dr Anupa Vig', '', 'dr-anupa-vig.png'], ['Dr Amol K Joshi', '', 'dr-amol-k-joshi.png'],
      ['Dr Lekha Viswanath', '', 'dr-lekha-viswanath.png'], ['Dr Prabha Ranjan', '', 'dr-prabha-ranjan.png'], ['Dr Anjali Kaushik', '', 'dr-anjali-kaushik.png'],
      ['Prof Smriti Arora', '', 'prof-smriti-arora.png'],
    ] },
    { title: 'NQOCN Governing Board', people: [
      ['Dr Vikram Datta', '', 'dr-vikram-datta.png'], ['Dr Vidyadhar Bangal', '', 'dr-vidyadhar-bangal.png'], ['Dr Anjali Kaushik', '', 'dr-anjali-kaushik.png'],
      ['Ms Susy Sarah John', '', 'ms-susy-sarah-john.png'], ['Dr Suprabha Patnaik', '', 'dr-suprabha-patnaik.png'], ['Dr Amol K Joshi', '', 'dr-amol-k-joshi.png'],
      ['Dr Jeena Pradeep', '', 'dr-jeena-pradeep.png'], ['Dr Chhaya Valvi', '', 'dr-chhaya-valvi.png'], ['Prof Shreeja Vijayan', '', 'prof-shreeja-vijayan.png'],
      ['Prof (Dr) Harish K Pemde', '', 'harish-pemde.jpeg'],
    ] },
  ].map((g) => ({ title: g.title, people: g.people.map(([name, role, photo]) => ({ name, role, photo: `people/${photo}` })) })),

  partners: [
    { name: 'UNICEF', file: 'partners/unicef.png' },
    { name: 'World Health Organization', file: 'partners/who.png' },
    { name: 'Aastrika', file: 'partners/aastrika.png' },
    { name: 'Breastfeeding Promotion Network of India (BPNI)', file: 'partners/bpni.jpg' },
    { name: 'ARSI', file: 'partners/arsi.gif' },
    { name: 'Consortium of Accredited Healthcare Organizations (CAHO)', file: 'partners/caho.png' },
    { name: 'Indian Association of Preventive and Social Medicine (IAPSM)', file: 'partners/iapsm.png' },
    { name: 'Telemedicine Society of India', file: 'partners/telemedicine-society-of-india.png' },
    { name: 'Maharashtra University of Health Sciences (MUHS)', file: 'partners/muhs.png' },
    { name: 'PCI India', file: 'partners/pci-india.png' },
  ],

  // Field visits and on-campus practice, by programme option id: what each
  // shows. Names, places, times and who leads them come from the portal.
  practices: {
    12: { about: 'Respectful, low-intervention birthing units for normal deliveries, and what they have done for maternal outcomes.', activities: [] },
    13: { about: 'How frontline workers use structured home and group visits to track and improve early childhood outcomes.', activities: ['Home visits by ASHA / AWW', "Mothers' meetings"] },
    14: { about: 'How the public health system brings outreach, primary care and nutrition together at the village level.', activities: ['Village Health and Nutrition Day', 'Community-owned primary care clinics', 'Public health system QI'] },
    15: { about: 'Medical students organise and drive quality improvement projects through a student parliament.', activities: [] },
  },

  // Abstract guidelines (Abstarct_Instructions.aspx on the earlier site).
  // The last date is the portal's (Conference setup), not written here.
  abstracts: {
    rules: [
      ['5 + 2', 'minutes for an oral: five to present, two for questions'],
      ['Top 5', 'papers go to the Award Paper session'],
      ['NQOCN Gold Medal', 'for the winner of the award session'],
      ['Certificates', 'for every presenter; prizes for the best paper and poster'],
    ],
    // The model abstract, as a page (/website/sample-abstract). For
    // reference only: the format, not a submission.
    sample: {
      title: 'Quality improvement in Kangaroo Mother Care: learning from a teaching hospital',
      details: [
        ['Category', 'Oral / poster'],
        ['Authors', 'Amol Joshi, Atul Londhe, Trupti Joshi, Laxmikant Deshmukh'],
        ['Institution', 'Government Medical College, Aurangabad'],
        ['Corresponding author', 'Email address and telephone number'],
        ['Word count', '316 words (up to 400)'],
      ],
      sections: [
        ['Background', 'Kangaroo Mother Care (KMC) is a low-resource, evidence-based, high-impact intervention for low-birth weight (LBW) care. Quality improvement in KMC requires meso-level, macro-level and micro-level interventions. Our institution, a public teaching hospital, hosts a level-II/III neonatal intensive care unit (NICU). The average demand for beds typically exceeds available capacity, with 60% occupancy attributed to LBW patients. There was low uptake of KMC practice at our unit.'],
        ['Aim statement', 'In the initial phase, we aimed to improve the coverage of KMC in admitted eligible neonates from a baseline of 20%–80% within 15 days. After a period of complacency, we revised the aim statement with a target of improving the percentage of babies receiving 6-hour KMC from 30% to 80% in 12 weeks.'],
        ['Methods', 'We report this quasi-experimental time-series study. With the Point of Care Quality Improvement methodology, we performed Plan-Do-Study-Act (PDSA) cycles to improve KMC practice. We involved all the healthcare workers, mothers and caregivers to customise various KMC tools (KMC book format, KMC bag, mother\u2019s gown) and minimise interruptions. Feedback from all levels guided our PDSA cycles.'],
        ['Results', 'The percentage of babies receiving at least 1-hour KMC increased from 20% to 100% within 15 days of August 2017. In the improvement phase, baseline 6-hour KMC coverage of 30% increased to 80% within 12 weeks (October–December 2017). It sustained for more than 2 years (January 2018 till February 2020) at 76.5%±2.49%.'],
        ['Conclusions', 'Quality improvement methods helped increase the coverage and percentage of babies receiving 6-hour KMC per day in our NICU. The duration specified KMC coverage should be adopted as the quality indicator of KMC. The training of healthcare workers and KMC provider should include hands-on sessions involving the mother and the baby. Maintaining data and providing suitable KMC tools are necessary elements for improving KMC. Minimising interruption is possible with family support and appropriate scheduling of activities. Having a designated KMC block helps in peer motivation.'],
      ],
    },
    sections: [
      { title: 'Eligibility and format', items: [
        'Only registered delegates may submit a paper or a poster.',
        'The conference theme is healthcare quality and patient safety.',
        'Submit a structured abstract — Background, Aim, Methods, Results, Conclusion — of no more than 400 words.',
        'A model abstract shows the format: see the sample abstract.',
      ] },
      { title: 'Review and presentation categories', items: [
        'An expert scientific committee evaluates every submission; its decision is final.',
        'Corresponding authors are told whether their abstract is accepted for an oral presentation or a poster presentation.',
        'The scientific committee shortlists the five best papers for the Award Paper session.',
      ] },
      { title: 'Awards and recognition', items: [
        'The winner of the Award Paper session receives the NQOCN Gold Medal.',
        'Prizes are awarded in different categories for the best scientific paper and poster.',
        'Every paper presenter receives a certificate.',
      ] },
      { title: 'Presentation rules', items: [
        'Presentations are on 22 November 2026; the time and venue are sent in advance.',
        'An oral presentation has 5 minutes to present and 2 minutes for discussion.',
        "The judges' questions are answered by the presenter and co-author only.",
      ] },
    ],
  },

  routes: [
    { kind: 'By air', distance: '70 km', from: 'Nagpur airport', text: 'Taxis and buses run regularly between Nagpur and Wardha.' },
    { kind: 'By train', distance: '6 km', from: 'Sevagram station (Wardha Jn., 8 km)', text: 'Well connected across India; autos run between the stations and MGIMS.' },
    { kind: 'By road', distance: 'Buses', from: 'From Pune, Nagpur, Hyderabad, Aurangabad and Indore', text: 'Wardha is on the Pune–Nagpur corridor, with regular state transport services.' },
  ],

  hotels: [
    { name: 'Yatri Niwas, Sevagram', address: 'Sevagram, Wardha 442102, next to the MGIMS campus', phone: '+91 88301 00705', distance: '~1 km', closest: true },
    { name: 'Hotel Utsav', address: 'Bachelor Road, Krishna Nagar, near the railway station, Wardha 442001', phone: '+91 78882 01551', distance: '~8 km' },
    { name: 'Hotel Poonam Residency', address: 'Gitainagar, Nalwadi, Wardha 442001', phone: '+91 92264 06565', distance: '~8 km' },
    { name: 'Hotel Harrison Royale', address: 'Opposite Indian Overseas Bank, near Rajkala Talkies, Maganwadi, Wardha 442001', phone: '+91 87887 49055', distance: '~8 km' },
    { name: 'Hotel Vrindavan', address: 'Near the railway station, Shastri Chowk, Maganwadi, Wardha 442001', phone: '+91 91450 30111', distance: '~8 km' },
    { name: 'Hotel Shavin Residency', address: '217 Kelkarwadi, Sudampuri, Wardha 442001', phone: '+91 93564 29581', distance: '~8 km' },
    { name: 'Hotel Ganesha Inn', address: '3rd floor, Shende Plaza, Arti Square, Nagpur Road, Wardha 442001', phone: '+91 77748 48428', distance: '~9 km' },
    { name: 'Hotel Ashoka Inn', address: 'Beside Shri Sai Auto, Sudampuri, Nagpur Road, Wardha 442001', phone: '+91 96891 32562', distance: '~9 km' },
  ],
};
