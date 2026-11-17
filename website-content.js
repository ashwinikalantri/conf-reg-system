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
      ['Dr Ashwini Kalantri', '', 'dr-ashwini-kalantri.png'], ['Dr Arjun Jakasania', '', 'dr-arjun-jakasania.png'], ['Mrs Ancy Ramesh', '', 'mrs-ancy-ramesh.png'],
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
    { name: 'ARSI', file: 'partners/arsi.png' },
    { name: 'Consortium of Accredited Healthcare Organizations (CAHO)', file: 'partners/caho-logo.png' },
    { name: 'Indian Association of Preventive and Social Medicine (IAPSM)', file: 'partners/iapsm.png' },
    { name: 'Telemedicine Society of India', file: 'partners/telemedicine-society-of-india.png' },
    { name: 'Maharashtra University of Health Sciences (MUHS)', file: 'partners/muhs-logo.png' },
    { name: 'PCI India', file: 'partners/pci-india-logo.png' },
    { name: 'Centre for Catalyzing Change (C3)', file: 'partners/c3.png' },
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
      ['6 + 2', 'minutes for a paper: six to present, two for discussion'],
      ['Top 5', 'papers go to the Award Paper session'],
      ['NQOCN Gold Medal', 'for the winner of the award session'],
      ['Certificates', 'for every presenter who presents in person; prizes for the best paper and poster'],
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
        'Every presenter who presents in person receives a presentation certificate.',
      ] },
      { title: 'Presentation rules', items: [
        'Presentations are on 22 November 2026; the time and venue are sent in advance.',
        'A paper has 6 minutes to present and 2 for discussion; an award paper 7 and 3; an e-poster 5 and 2.',
        'Every presentation is made on the official template and uploaded in the portal before the conference: see the presentation guidelines.',
        "The judges' questions are answered by the presenter and co-author only.",
      ] },
    ],
  },

  // Presentation guidelines (/website/presentations), from the organisers'
  // "Guidelines for E-Poster and Paper Presentations" of November 2026 --
  // except that files are uploaded in the portal, not emailed, a paper may be
  // a PDF or a .pptx, and the templates are the conference's own (the
  // ePoster of 3 Nov, and the paper template made on its lines), so what is
  // said about using them follows those. The last date is the portal's (abstracts desk,
  // Step 3), not written here. An item is text, or [lead, text].
  presentations: {
    times: [
      ['5 + 2', 'minutes for an e-poster: five to present, two for questions'],
      ['6 + 2', 'minutes for a paper: six to present, two for discussion'],
      ['7 + 3', 'minutes for an award paper: seven to present, three for discussion'],
    ],
    parts: [
      { id: 'general', title: 'For everyone', lead: 'Every accepted abstract is presented either as an e-poster or as an oral paper. Both are prepared on the official NQOCN templates.', groups: [
        { items: [
          ['Eligibility.', 'Only abstracts accepted by the Scientific Committee may be presented. Your acceptance email gives your presentation type, and the portal your Registration No.'],
          ['Registration.', 'The presenting author must be registered for the conference. Presentations by unregistered authors are withdrawn from the programme.'],
          ['Presenting author.', 'One author presents each abstract, in person, at the allotted time.'],
          ['Templates.', 'Use only the official e-poster template or paper template, from this page. Presentations in any other format are not accepted.'],
          ['Branding.', 'Do not alter the NQOCN and MGIMS logos, the conference name or the background colour. You may resize, move or delete the content boxes.'],
          ['Slide format.', 'Both templates are 16:9 widescreen. Do not change the slide size or orientation.'],
          ['Language.', 'All slides, and the presentation itself, are in English.'],
          ['Consistency.', 'The title, authors and content must match the accepted abstract. You may update results that were pending at submission.'],
          ['Patient confidentiality.', 'Show no patient names, hospital numbers, faces or other identifying details. Clinical photographs need documented consent and must be de-identified.'],
          ['Originality.', 'The work must be your own and properly referenced. Plagiarised or fabricated content leads to disqualification.'],
        ] },
      ] },
      { id: 'eposter', title: 'E-posters', lead: 'An e-poster is one 16:9 slide. It is shown on display screens at the venue and presented to judges in a moderated session.', groups: [
        { title: 'Using the template', items: [
          'The template is one slide with five sections, each marked by a petal of the NQOCN flower: Background, Aim statement, Methods, Results and Conclusions. Slide 2 is a worked example, from the sample abstract: delete it before you save.',
          'Replace "Title of your abstract, as accepted" with your title exactly as accepted.',
          'Fill in the authors, marking the presenting author, and the department, institution and city.',
          'Change "Abstract #000" in the top-right box to your abstract number, and put your name and email in the presenting author line at the foot.',
          'Results: right-click the run chart and choose Edit Data to put in your own numbers, or replace it with your own chart, table or photo.',
        ] },
        { title: 'Content', items: [
          'Keep to the five section headings. Rename one only where your work needs it.',
          'Aim for about 300–500 words in all: a poster is a visual summary, not the full paper.',
          'Use short bullet points rather than paragraphs, and lead with your key message.',
          'Prefer graphs, run charts, flow diagrams and tables to text. Label the axes and give units.',
          'QI posters show the problem, a SMART aim, the change ideas, the measures (outcome, process and balancing), and a run or control chart where there is one.',
          'List up to 3 key references in one style (Vancouver recommended).',
        ] },
        { title: 'Design and readability', items: [
          "Use the template's fonts and colours; if you change the font, use a clear sans-serif such as Arial or Calibri.",
          'Keep text at 14 pt or larger, as the template sets it, so it can be read on the screen.',
          'Images of at least 150 dpi. Rebuild tables in PowerPoint rather than pasting blurry screenshots.',
          'Strong contrast between text and background.',
          'No animations, transitions, audio, video or hyperlinks.',
          'Keep text inside its boxes: resize the boxes instead.',
        ] },
        { title: 'Your file', items: [
          ['A PDF,', 'with one slide only, under 10 MB: in PowerPoint, File › Save As › PDF.'],
          ['Upload it in the delegate portal,', 'on the Abstract card, by the last date. The portal names the file for you.'],
          'Late changes are not accepted.',
        ] },
        { title: 'At the conference', items: [
          'E-posters are displayed on screens in the main auditorium.',
          'You have 5 minutes to present and 2 for questions in your moderated session. The programme gives your date, time and screen.',
          'Report to the e-poster area at least 15 minutes before your session, and keep to time: the moderator stops presentations that overrun.',
          'Only e-posters presented in person are eligible for awards and presentation certificates.',
        ] },
      ] },
      { id: 'paper', title: 'Papers (oral presentations)', lead: 'Each paper has 6 minutes to present and 2 for discussion, delivered in person on the paper template.', groups: [
        { title: 'Using the template', items: [
          'Slide 1, the title slide: the paper title as accepted, the authors with the presenting author underlined, the institution, and the presenting author\'s name and email. Change "Abstract #000" to your abstract number.',
          'Slides 2 to 9 follow the structure below, each part marked by its petal. Make each slide\'s title its one message, and put the content in the white card.',
          'Duplicate a slide for more (right-click it › Duplicate Slide) and delete those you do not use.',
          'Results: right-click the run chart and choose Edit Data for your own numbers; the table is for the outcome, process and balancing measures.',
          'Keep the conference name, the logo and the petals as they are on every slide.',
        ] },
        { title: 'A suggested structure, in 8–10 slides', items: [
          'Title slide.',
          'Background and rationale.',
          'Aim and objectives.',
          'Methods: design, setting, participants, intervention or change ideas, and analysis.',
          'Results, in two or three slides.',
          'Discussion: what the findings mean, how they compare with other work, and the limitations.',
          'Conclusions, and recommendations or next steps.',
          'Acknowledgements, funding, conflicts of interest and key references.',
        ] },
        { title: 'Slide design', items: [
          'One message per slide, stated in its title; no more than six bullet points.',
          'Body text at least 24 pt, slide titles at least 28 pt.',
          'Data as graphs, run charts or simple tables rather than text. Label the axes and give units and n.',
          'High-resolution images; no screenshots of dense tables.',
          'Keep animations minimal, with no sound effects. Embed any video in the file rather than linking to it, and test it beforehand.',
          'Check the spelling, expand abbreviations at first use, and number the slides.',
        ] },
        { title: 'Your file', items: [
          ['A PDF or a PowerPoint (.pptx) file,', '16:9, under 50 MB. A video plays only from the PowerPoint file.'],
          ['Upload it in the delegate portal,', 'on the Abstract card, by the last date. The portal names the file for you.'],
          'Bring a backup copy on a USB drive. Personal laptops cannot be connected in the session halls.',
        ] },
        { title: 'On the day', items: [
          "Report to the Speakers' Preview Room at least 30 minutes before your session to check your file on the conference computer.",
          'Be seated in the hall 15 minutes before the session starts.',
          'Keep strictly to time: you are warned at 1 minute remaining, and the chairperson stops presentations that overrun.',
          'Answer questions briefly; the discussion can continue after the session.',
          'Only papers presented in person are eligible for awards and presentation certificates.',
        ] },
      ] },
      { id: 'award', title: 'Award papers', lead: 'Award papers are presented on the paper template, in 7 minutes, with 3 for discussion.', groups: [
        { title: 'Preparing your presentation', items: [
          'Use the official paper template, in about 8–10 slides. Do not alter the NQOCN and MGIMS logos.',
          'Title slide: the title of the study, the presenting author, the other authors, and the institute where the study was done.',
          'Introduction (1–2 slides): background, aim and objectives.',
          'QI methodology (2 slides): the problem, SMART aim, setting, team, change ideas or PDSA cycles, and the measures (outcome, process and balancing).',
          'Results (2–3 slides): the key findings as charts, graphs or run charts.',
          'Conclusion (1 slide): key conclusions, sustainability and next steps.',
          'A clear font, readable from a distance, such as Arial or Calibri: at least 24 pt for body text and 28 pt for titles.',
        ] },
        { title: 'Your file', items: [
          ['A PDF or a PowerPoint (.pptx) file,', 'under 50 MB, uploaded in the delegate portal on the Abstract card by the last date. The portal names the file for you.'],
        ] },
        { title: 'Evaluation', lead: 'Award papers are judged on:', items: [
          'relevance to healthcare quality and patient safety;',
          'soundness of the QI methodology;',
          'results and impact;',
          'clarity of the slides;',
          'keeping to time;',
          'the answers in the discussion.',
        ] },
        { items: [
          'The chairperson stops presentations that overrun.',
          'Only papers presented in person by the registered presenting author are eligible for the award. The judges\' decision is final.',
        ] },
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
