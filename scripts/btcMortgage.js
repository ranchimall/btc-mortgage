(function (EXPORTS) {
    const btcMortgage = EXPORTS;

    //USERS: B: Borrower, L: Lender, C: Collateral provider, T: Trusted banker (us)

    const APP_NAME = "BTCMortgage";
    const APP_IDENTIFIER = "BTC Mortgage";
    const BANKER_ID = "";
    const BANKER_PUBKEY = "";

    const CURRENCY = "USD";
    const ALLOWED_DEVIATION = 0.98, //ie, upto 2% of decrease in rate can be accepted in processing stage
        WAIT_TIME = 24 * 60 * 60 * 1000;//24 hrs
    const PERIOD_REGEX = /^\d{1,5}(Y|M|D)$/,
        TXID_REGEX = /^[0-9a-f]{64}$/i,
        VALUE_REGEX = /^\d+(.\d{1,8})?$/;

    const
        TYPE_LOAN_COLLATERAL_REQUEST = "type_loan_collateral_request",
        TYPE_LOAN_REQUEST = "type_loan_request",
        TYPE_LENDER_RESPONSE = "type_loan_response",
        TYPE_COLLATERAL_LOCK_REQUEST = "type_collateral_lock_request",
        TYPE_COLLATERAL_LOCK_ACK = "type_collateral_lock_ack",
        TYPE_LOAN_CLOSED_ACK = "type_loan_closed_ack",
        TYPE_UNLOCK_COLLATERAL_REQUEST = "type_unlock_collateral_request",
        TYPE_UNLOCK_COLLATERAL_ACK = "type_unlock_collateral_ack",
        TYPE_REFUND_COLLATERAL_REQUEST = "type_refund_collateral_request",
        TYPE_REFUND_COLLATERAL_ACK = "type_refund_collateral_ack",
        TYPE_LIQUATE_COLLATERAL_REQUEST = "type_liquate_collateral_request",
        TYPE_LIQUATE_COLLATERAL_ACK = "type_liquate_collateral_ack",
        TYPE_PRELIQUATE_COLLATERAL_REQUEST = "type_preliquate_collateral_request";
    TYPE_PRELIQUATE_COLLATERAL_ACK = "type_preliquate_collateral_ack";

    const POLICIES = {}

    const toFixedDecimal = value => parseFloat((value).toFixed(8));

    function encodePeriod(str) {

        if (typeof str != 'string')
            throw "passed value must be string";

        if (PERIOD_REGEX.test(str)) //already in format
            return str;

        let P = '', n = 0;
        str.toLowerCase().replace(/,/g, '').split(" ").forEach(s => {
            if (!isNaN(s))
                n = parseInt(s);
            else switch (s) {
                case "year(s)": case "year": case "years": P += (n + 'Y'); n = 0; break;
                case "month(s)": case "month": case "months": P += (n + 'M'); n = 0; break;
                case "day(s)": case "day": case "days": P += (n + 'D'); n = 0; break;
            }
        });

        if (!PERIOD_REGEX.test(P)) {//not in format: something wrong
            console.error(`encodePeriod('${str}') failed`, P)
            throw "Invalid period";
        }

        return P;
    }

    function decodePeriod(str) {
        if (typeof str != 'string')
            throw "passed value must be string";

        else if (!PERIOD_REGEX.test(str)) //not in format
            throw "Invalid period";

        let n = parseInt(str);
        let v = str[str.length - 1];

        switch (v) {
            case 'Y': return n + (n == 1 ? "year" : "years");
            case 'M': return n + (n == 1 ? "month" : "months");
            case "D": return n + (n == 1 ? "day" : "days");
        }

    }

    const dateFormat = (date = null) => {
        let d = (date ? new Date(date) : new Date()).toDateString();
        return [d.substring(8, 10), d.substring(4, 7), d.substring(11, 15)].join(" ");
    }
    const yearDiff = (d1 = null, d2 = null) => {
        d1 = d1 ? new Date(d1) : new Date();
        d2 = d2 ? new Date(d2) : new Date();
        let y = d1.getYear() - d2.getYear(),
            m = d1.getMonth() - d2.getMonth(),
            d = d1.getDate() - d2.getDate()
        return y + m / 12 + d / 365;
    }

    const dateAdder = function (start_date, duration) {
        let date = new Date(start_date);
        let y = parseInt(duration.match(/\d+Y/)),
            m = parseInt(duration.match(/\d+M/)),
            d = parseInt(duration.match(/\d+D/));
        if (!isNaN(y))
            date.setFullYear(date.getFullYear() + y);
        if (!isNaN(m))
            date.setMonth(date.getMonth() + m);
        if (!isNaN(d))
            date.setDate(date.getDate() + d);
        return date;
    }

    function calcAllowedLoan(collateralQuantity, security_percent) {
        return collateralQuantity * security_percent;
    }

    function calcRequiredCollateral(loanEquivalent, security_percent) {
        let inverse_security_percent = 1 / security_percent;
        return loanEquivalent * inverse_security_percent;
    }

    function calcDueAmount(loan_amount, policy_id, open_time, close_time = Date.now()) {
        let policy = POLICIES[policy_id],
            duration = yearDiff(close_time, open_time);
        let interest_amount = loan_amount * policy.interest * duration;
        let due_amount = loan_amount + interest_amount;
        return due_amount;
    }

    function calcRateDropPercent(start_rate, current_rate) {
        let drop_value = start_rate - current_rate;
        let drop_percent = drop_value / start_rate;
        return drop_percent;
    }

    function findLocker(coborrower_pubKey, lender_pubKey) {
        return btcOperator.multiSigAddress([coborrower_pubKey, lender_pubKey, BANKER_PUBKEY], 2);
    }

    function extractPubKeyFromSign(sign) {
        return sign.split('.')[0];
    }

    btcMortgage.util = {
        toFixedDecimal,
        encodePeriod, decodePeriod,
        calcAllowedLoan, calcRequiredCollateral,
        findLocker, extractPubKeyFromSign
    }

    //get BTC rates
    const getRate = btcMortgage.getRate = {};

    getRate["BTC"] = function () {
        return new Promise((resolve, reject) => {
            fetch('https://api.coinlore.net/api/ticker/?id=90').then(response => {
                if (response.ok) {
                    response.json()
                        .then(result => resolve(result[0].price_usd))
                        .catch(error => reject(error));
                } else
                    reject(response.status);
            }).catch(error => reject(error));
        });
    }

    //function to read all policy from blockchain
    function readPoliciesFromBlockchain() {
        return new Promise((resolve, reject) => {
            const LASTTX_IDB_KEY = APP_NAME + ":" + BANKER_ID
            compactIDB.readData("lastTx", LASTTX_IDB_KEY).then(lastTx => {
                var query_options = { sentOnly: true, tx: true, filter: d => d.startsWith(APP_IDENTIFIER) };
                if (typeof lastTx == 'number')  //lastTx is tx count (*backward support)
                    query_options.ignoreOld = lastTx;
                else if (typeof lastTx == 'string') //lastTx is txid of last tx
                    query_options.after = lastTx;
                floBlockchainAPI.readData(BANKER_ID, query_options).then(result => {
                    let p = [];
                    for (var i = result.items.length - 1; i >= 0; i--) {
                        let t = result.items[i];
                        if (t.data.startsWith(LOAN_POLICY_IDENTIFIER)) {
                            let policy_id = t.txid,
                                policy_details = parsePolicyData(t.data, t.time);
                            p.push(compactIDB.addData("policies", policy_details, policy_id));
                        }
                    }
                    Promise.all(p).then(result => {
                        compactIDB.writeData("lastTx", result.lastItem, LASTTX_IDB_KEY);
                        compactIDB.readAllData("policies").then(result => {
                            for (let p in result)
                                POLICIES[p] = result[p];
                            resolve(POLICIES);  //MAYBE: resolve a copy of it?
                        })
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //Policy details 
    const LOAN_POLICY_IDENTIFIER = APP_IDENTIFIER + ": Loan policy";
    function stringifyPolicyData(duration, interest, pre_liquidation_threshold, loan_collateral_ratio) {
        return [
            LOAN_POLICY_IDENTIFIER,
            "Duration:" + decodePeriod(duration),
            "Interest per annum:" + interest,
            "Pre-Liquidation threshold:" + pre_liquidation_threshold,
            "Loan to Collateral ratio:" + loan_collateral_ratio
        ].join('|');
    }

    function parsePolicyData(str, tx_time) {
        let splits = str.split('|');
        if (splits[0] !== LOAN_POLICY_IDENTIFIER)
            throw "Invalid Loan Policy data";
        var details = { policy_creation_time: tx_time };
        splits.forEach(s => {
            let d = s.split(':');
            switch (d[0]) {
                case "Duration": details.duration = encodePeriod(d[1]); break;
                case "Interest per annum": details.interest = parseFloat(d[1]); break;
                case "Pre-Liquidation threshold": details.pre_liquidation_threshold = parseFloat(d[1]); break;
                case "Loan to Collateral ratio": details.loan_collateral_ratio = parseFloat(d[1]); break;
            }
        });
        return details;
    }

    //Loan details on FLO blockchain
    const LOAN_DETAILS_IDENTIFIER = APP_IDENTIFIER + ": Loan details";

    function stringifyLoanOpenData(
        borrower, loan_amount, policy_id, btc_start_rate,
        coborrower, collateral_value, collateral_lock_id,
        lender, loan_transfer_id,
        borrower_sign, coborrower_sign, lender_sign
    ) {
        return [
            LOAN_DETAILS_IDENTIFIER,
            "Borrower:" + floCrypto.toFloID(borrower),
            "Amount:" + loan_amount,
            "Policy:" + policy_id,
            "CoBorrower:" + floCrypto.toFloID(coborrower),
            "CollateralValue:" + collateral_value + "BTC",
            "CollateralLock:" + collateral_lock_id,
            "BTC price:" + btc_start_rate + "USD",
            "Lender:" + floCrypto.toFloID(lender),
            "TokenTransfer:" + loan_transfer_id,
            "Signature-B:" + borrower_sign,
            "Signature-C:" + coborrower_sign,
            "Signature-L:" + lender_sign
        ].join('|');
        /*MAYDO: Maybe make it a worded sentence?
            BTC Mortgage: 
            L#${lender_floid} is lending ${loan_amount}USD (ref#${loan_transfer_id}) to B#${borrower_floid}
            inaccoradance with policy#${policy_id} 
            as mortgage on collateral#${collateral_id} (${btc_amount}BTC) provided by C#${coborrower_floid}.
            Signed by B'${borrower_sign} , C'{coborrower_sign} and L'${lender_sign}    
        */
    }

    function parseLoanOpenData(str, txid, tx_time) {
        let splits = str.split('|');
        if (splits[0] !== LOAN_DETAILS_IDENTIFIER)
            throw "Invalid Loan blockchain data";
        var details = { loan_id: txid, open_time: tx_time };
        splits.forEach(s => {
            let d = s.split(':');
            switch (d[0]) {
                case "Borrower": details.borrower = d[1]; break;
                case "Amount": details.loan_amount = parseFloat(d[1]); break;
                case "Policy": details.policy_id = d[1]; break;
                case "CoBorrower": details.coborrower = d[1]; break;
                case "CollateralValue": details.collateral_value = parseFloat(d[1]); break;
                case "CollateralLock": details.collateral_lock_id = d[1]; break;
                case "BTC price:": details.btc_start_rate = parseFloat(d[1]); break;
                case "Lender": details.lender = d[1]; break;
                case "TokenTransfer": details.loan_transfer_id = d[1]; break;
                case "Signature-B": details.borrower_sign = d[1]; break;
                case "Signature-C": details.coborrower_sign = d[1]; break;
                case "Signature-L": details.lender_sign = d[1]; break;
            }
        });
        return details;
    }

    const getLoanDetails = btcMortgage.getLoanDetails = function (loan_id) {
        return new Promise((resolve, reject) => {
            floBlockchainAPI.getTx(loan_id).then(tx => {
                let parsed_loan_details = parseLoanOpenData(tx.floData, tx.txid, tx.time);
                validateLoanDetails(parsed_loan_details)
                    .then(_ => resolve(parsed_loan_details))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    const validateLoanDetails = btcMortgage.validateLoanDetails = function (loan_details) {
        return new Promise((resolve, reject) => {
            //validate floIDs
            if (!floCrypto.validateFloID(loan_details.borrower))
                return reject("Invalid borrower floID");
            if (!floCrypto.validateFloID(loan_details.coborrower))
                return reject("Invalid coborrower floID");
            if (!floCrypto.validateFloID(loan_details.lender))
                return reject("Invalid lender floID");
            //check policy
            if (!(loan_details.policy_id in POLICIES))
                return reject("Policy not found");
            //verify signatures
            if (!verify_borrowerSign(loan_details.borrower_sign, loan_details.borrower, loan_details.loan_amount, loan_details.policy_id, loan_details.coborrower, loan_details.lender))
                return reject("Invalid borrower signature");
            if (!verify_coborrowerSign(loan_details.coborrower_sign, loan_details.coborrower, loan_details.borrower_sign, loan_details.collateral_value, loan_details.collateral_lock_id))
                return reject("Invalid coborrower signature");
            if (!verify_lenderSign(loan_details.lender_sign, loan_details.lender, loan_details.coborrower_sign, loan_details.loan_transfer_id))
                return reject("Invalid lender signature");
            validateCollateralLock(loan_details.collateral_lock_id, extractPubKeyFromSign(loan_details.coborrower_sign), extractPubKeyFromSign(loan_details.lender_sign), loan_details.collateral_value).then(result => {
                validateLoanOpenTokenTransfer(loan_details.loan_transfer_id, loan_details.borrower, loan_details.lender, loan_details.loan_amount)
                    .then(result => resolve(true))
                    .catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    const validateCollateralLock = btcMortgage.validateCollateralLock = function (collateral_lock_id, coborrower_pubKey, lender_pubKey, collateral_value) {
        return new Promise((resolve, reject) => {
            btcOperator.getTx(collateral_lock_id).then(collateral_tx => {
                if (!collateral_tx.confirmations)
                    return reject("Collateral lock transaction not confirmed yet");
                let locker_id = findLocker(coborrower_pubKey, lender_pubKey).address;
                let locked_amt = collateral_tx.outputs.filter(o => o.address == locker_id).reduce((a, o) => a += o.value, 0);
                if (locked_amt < collateral_value)
                    return reject("Insufficient Collateral locked");
                resolve(true);
            }).catch(error => reject(error))
        })
    }

    const validateLoanOpenTokenTransfer = btcMortgage.validateLoanOpenTokenTransfer = function (loan_transfer_id, borrower, lender, loan_amount) {
        return new Promise((resolve, reject) => {
            floTokenAPI.getTx(loan_transfer_id).then(token_tx => {
                if (token_tx.parsedFloData.type != "transfer" || token_tx.parsedFloData.transferType != "token")
                    return reject("Transaction is not a token transfer");
                if (token_tx.parsedFloData.tokenIdentification != CURRENCY)
                    return reject("Transfered token is not " + CURRENCY);
                if (token_tx.transactionDetails.confirmations == 0)
                    return reject("Transaction not yet confirmed");
                if (token_tx.transactionDetails.receiverAddress != floCrypto.toFloID(borrower))
                    return reject("Receiver is not borrower");
                if (token_tx.transactionDetails.senderAddress != floCrypto.toFloID(lender))
                    return reject("Sender is not lender");
                if (token_tx.parsedFloData.tokenAmount !== loan_amount)
                    return reject("Token amount doesnot match the loan amount");
                resolve(true);
            }).catch(error => reject(error))
        })
    }

    const LOAN_CLOSING_IDENTIFIER = APP_IDENTIFIER + ": Loan closing";
    function stringifyLoanCloseData(loan_id, borrower, closing_sign) {
        return [
            LOAN_CLOSING_IDENTIFIER,
            "Borrower:" + floCrypto.toFloID(borrower),
            "Loan ID:" + loan_id,
            "Signature:" + closing_sign,
        ].join('|');
    }

    function parseLoanCloseData(str, txid, tx_time) {
        let splits = str.split('|');
        if (splits[1] !== LOAN_CLOSING_IDENTIFIER) //splits[0] will be token transfer
            throw "Invalid Loan closing data";
        var details = { close_time: tx_time, close_id: txid };
        splits.forEach(s => {
            let d = s.split(':');
            switch (d[0]) {
                case "Borrower": details.borrower = d[1]; break;
                case "Loan ID": details.loan_id = d[1]; break;
                case "Signature": details.closing_sign = d[1]; break;
            }
        });
        return details;
    }

    const getLoanClosing = btcMortgage.getLoanClosing = function (closing_txid) {
        return new Promise((resolve, reject) => {
            floBlockchainAPI.getTx(closing_txid).then(tx => {
                let closing_details = parseLoanCloseData(tx.floData, tx.time);
                getLoanDetails(closing_details.loan_id).then(loan_details => {
                    validateLoanClosing(loan_details, closing_details)
                        .then(result => resolve(Object.assign(loan_details, closing_details)))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    const validateLoanClosing = btcMortgage.validateLoanClosing = function (loan_details, closing_details) {
        return new Promise((resolve, reject) => {
            if (closing_details.loan_id !== loan_details.loan_id)
                return reject("Closing doesnot belong to this loan")
            if (!floCrypto.validateFloID(closing_details.borrower))
                return reject("Invalid borrower floID");
            if (closing_details.borrower != loan_details.borrower)
                return reject("Borrower ID is different");
            if (verify_closingSign(closing_details.closing_sign, closing_details.borrower, closing_details.loan_id, loan_details.lender_sign))
                return reject("Invalid closing signature");
            validateLoanCloseTokenTransfer(closing_details.close_id, loan_details.borrower, loan_details.lender, loan_details.loan_amount, loan_details.policy_id, loan_details.open_time, closing_details.close_time)
                .then(result => resolve(true))
                .catch(error => reject(error))
        })
    }

    const validateLoanCloseTokenTransfer = btcMortgage.validateLoanCloseTokenTransfer = function (close_id, borrower, lender, loan_amount, policy_id, open_time, close_time) {
        return new Promise((resolve, reject) => {
            floTokenAPI.getTx(close_id).then(token_tx => {
                if (token_tx.parsedFloData.type != "transfer" || token_tx.parsedFloData.transferType != "token")
                    return reject("Transaction is not a token transfer");
                if (token_tx.parsedFloData.tokenIdentification != CURRENCY)
                    return reject("Transfered token is not " + CURRENCY);
                if (token_tx.transactionDetails.confirmations == 0)
                    return reject("Transaction not yet confirmed");
                if (token_tx.transactionDetails.receiverAddress != floCrypto.toFloID(lender))
                    return reject("Receiver is not lender");
                if (token_tx.transactionDetails.senderAddress != floCrypto.toFloID(borrower))
                    return reject("Sender is not borrower");
                let repay_amount = calcDueAmount(loan_amount, policy_id, open_time, close_time);
                if (token_tx.parsedFloData.tokenAmount < repay_amount)
                    return reject("Token amount is less than loan repayment amount");
                resolve(true);
            }).catch(error => reject(error))
        })
    }

    /*Signature and verification */
    function sign_borrower(privKey, loan_amount, policy_id, coborrower, lender) {
        let borrower_floID = floCrypto.toFloID(floDapps.user.id),
            coborrower_floID = floCrypto.toFloID(coborrower),
            lender_floID = floCrypto.toFloID(lender);
        //validate values before signing
        if (!floCrypto.verifyPrivKey(privKey, borrower_floID))
            throw "Invalid Private key for borrower";
        if (typeof loan_amount !== "number" || !VALUE_REGEX.test(loan_amount))
            throw "Invalid loan amount";
        if (!(policy_id in POLICIES))
            throw "Invalid Policy";
        if (!floCrypto.validateFloID(coborrower_floID, true))
            throw "Invalid coborrower floID";
        if (!floCrypto.validateFloID(lender_floID, true))
            throw "Invalid lender floID";
        //sign the value-data
        let timestamp = Date.now();
        let doc_array = [timestamp, borrower_floID, coborrower_floID, lender_floID, loan_amount, policy_id];
        let sign_part = floCrypto.signData(doc_array.join("|"));
        let pubKey = floCrypto.getPubKeyHex(privKey);
        let borrower_sign = [pubKey, sign_part, timestamp].join(".")
        return borrower_sign;
    }

    function verify_borrowerSign(borrower_sign, borrower, loan_amount, policy_id, coborrower, lender) {
        //split the signature part
        let sign_splits = borrower_sign.split('.');
        let borrower_pubKey = sign_splits[0],
            sign_part = sign_splits[1],
            timestamp = sign_splits[2];
        let borrower_floID = floCrypto.getFloID(borrower_pubKey),
            coborrower_floID = floCrypto.toFloID(coborrower),
            lender_floID = floCrypto.toFloID(lender);
        //validate values
        if (!floCrypto.verifyPubKey(borrower_pubKey, borrower))
            throw "Invalid public key";
        if (typeof loan_amount !== "number" || !VALUE_REGEX.test(loan_amount))
            throw "Invalid loan amount";
        if (!(policy_id in POLICIES))
            throw "Invalid Policy";
        if (!floCrypto.validateFloID(borrower_floID, true))
            throw "Invalid borrower floID";
        if (!floCrypto.validateFloID(coborrower_floID, true))
            throw "Invalid coborrower floID";
        if (!floCrypto.validateFloID(lender_floID, true))
            throw "Invalid lender floID";
        //verify the signature
        let doc_array = [timestamp, borrower_floID, coborrower_floID, lender_floID, loan_amount, policy_id];
        if (floCrypto.verifySign(doc_array.join("|"), sign_part, borrower_pubKey))
            return timestamp;
        else return false;
    }

    function sign_coborrower(privKey, borrower_sign, collateral_rate, collateral_value, collateral_lock_id) {
        let coborrower_floID = floCrypto.toFloID(floDapps.user.id);
        //validate values before signing
        if (!floCrypto.verifyPrivKey(privKey, coborrower_floID))
            throw "Invalid Private key for coborrower";
        if (typeof collateral_rate !== "number" || !VALUE_REGEX.test(collateral_rate))
            throw "Invalid collateral rate";
        if (typeof collateral_value !== "number" || !VALUE_REGEX.test(collateral_value))
            throw "Invalid collateral amount";
        if (typeof collateral_lock_id !== 'string' || !TXID_REGEX.test(collateral_lock_id))
            throw "Invalid collateral lock id";
        //sign the value-data
        let timestamp = Date.now();
        let doc_array = [timestamp, borrower_sign, collateral_rate, collateral_value, collateral_lock_id];
        let sign_part = floCrypto.signData(doc_array.join("|"));
        let pubKey = floCrypto.getPubKeyHex(privKey);
        let coborrower_sign = [pubKey, sign_part, timestamp].join(".")
        return coborrower_sign;
    }

    function verify_coborrowerSign(coborrower_sign, coborrower, borrower_sign, collateral_rate, collateral_value, collateral_lock_id) {
        //split the signature part
        let sign_splits = coborrower_sign.split('.');
        let coborrower_pubKey = sign_splits[0],
            sign_part = sign_splits[1],
            timestamp = sign_splits[2];
        //validate values
        if (!floCrypto.verifyPubKey(coborrower_pubKey, coborrower))
            throw "Invalid public key";
        if (typeof collateral_rate !== "number" || !VALUE_REGEX.test(collateral_rate))
            throw "Invalid collateral rate";
        if (typeof collateral_value !== "number" || !VALUE_REGEX.test(collateral_value))
            throw "Invalid collateral amount";
        if (typeof collateral_lock_id !== 'string' || !TXID_REGEX.test(collateral_lock_id))
            throw "Invalid collateral lock id";
        //verify the signature
        let doc_array = [timestamp, borrower_sign, collateral_rate, collateral_value, collateral_lock_id];
        if (floCrypto.verifySign(doc_array.join("|"), sign_part, coborrower_pubKey))
            return timestamp;
        else return false;
    }

    function sign_lender(privKey, coborrower_sign, loan_transfer_id) {
        let lender_floID = floCrypto.toFloID(floDapps.user.id);
        //validate values before signing
        if (!floCrypto.verifyPrivKey(privKey, lender_floID))
            throw "Invalid Private key for lender";
        if (typeof loan_transfer_id !== 'string' || !TXID_REGEX.test(loan_transfer_id))
            throw "Invalid token transfer id";
        //sign the value-data
        let timestamp = Date.now();
        let doc_array = [timestamp, coborrower_sign, loan_transfer_id];
        let sign_part = floCrypto.signData(doc_array.join("|"));
        let pubKey = floCrypto.getPubKeyHex(privKey);
        let lender_sign = [pubKey, sign_part, timestamp].join(".")
        return lender_sign;
    }

    function verify_lenderSign(lender_sign, lender, coborrower_sign, loan_transfer_id) {
        //split the signature part
        let sign_splits = lender_sign.split('.');
        let lender_pubKey = sign_splits[0],
            sign_part = sign_splits[1],
            timestamp = sign_splits[2];
        //validate values
        if (!floCrypto.verifyPubKey(lender_pubKey, lender))
            throw "Invalid public key";
        if (typeof loan_transfer_id !== 'string' || !TXID_REGEX.test(loan_transfer_id))
            throw "Invalid token transfer id";
        //verify the signature
        let doc_array = [timestamp, coborrower_sign, loan_transfer_id];
        if (floCrypto.verifySign(doc_array.join("|"), sign_part, lender_pubKey))
            return timestamp;
        else return false;
    }

    //Signed by borrower when closing the loan
    const CLOSING_IDENTIFIER = "closing";
    function sign_closing(privKey, loan_id, lender_sign) {
        let borrower_floID = floCrypto.toFloID(floDapps.user.id)
        //validate values before signing
        if (!floCrypto.verifyPrivKey(privKey, borrower_floID))
            throw "Invalid Private key for borrower";
        if (typeof loan_id !== 'string' || !TXID_REGEX.test(loan_id))
            throw "Invalid loan id";
        //sign the value-data
        let timestamp = Date.now();
        let doc_array = [timestamp, CLOSING_IDENTIFIER, loan_id, lender_sign];
        let sign_part = floCrypto.signData(doc_array.join("|"));
        let pubKey = floCrypto.getPubKeyHex(privKey);
        let closing_sign = [pubKey, sign_part, timestamp].join(".")
        return closing_sign;
    }

    function verify_closingSign(closing_sign, borrower, loan_id, lender_sign) {
        //split the signature part
        let sign_splits = closing_sign.split('.');
        let borrower_pubKey = sign_splits[0],
            sign_part = sign_splits[1],
            timestamp = sign_splits[2];
        //validate values
        if (!floCrypto.verifyPubKey(borrower_pubKey, borrower))
            throw "Invalid public key";
        //verify the signature
        let doc_array = [timestamp, CLOSING_IDENTIFIER, loan_id, lender_sign];
        if (floCrypto.verifySign(doc_array.join("|"), sign_part, borrower_pubKey))
            return timestamp;
        else return false;
    }

    btcMortgage.verify = {
        borrower_sign: verify_borrowerSign,
        coborrower_sign: verify_coborrowerSign,
        lender_sign: verify_lenderSign,
        closing_sign: verify_closingSign
    }

    const validateRequest = btcMortgage.validateRequest = {};

    const RequestValidationError = (req_type, message) => { req_type, message };

    /*Inbox / Board */

    //list all loan requests
    btcMortgage.listLoanRequests = function (callback = undefined) {
        return new Promise((resolve, reject) => {
            let options = {}
            if (callback instanceof Function)
                options.callback = callback;
            floCloudAPI.requestApplicationData(TYPE_LOAN_REQUEST, options)
                .then(result => resolve(result))
                .catch(error => reject(error))
        })
    }

    //view responses 
    btcMortgage.viewMyInbox = function () {
        return new Promise((resolve, reject) => {
            let options = { receiverID: floDapps.user.id }
            if (callback instanceof Function)
                options.callback = callback;
            floCloudAPI.requestApplicationData(null, options)   //view all inbox
                .then(result => resolve(result))
                .catch(error => reject(error))
        })
    }


    /*Loan Opening*/

    //1. B: requests collateral from coborrower
    btcMortgage.requestLoanCollateral = function (loan_amount, policy_id, coborrower) {
        return new Promise((resolve, reject) => {
            const borrower = floDapps.user.id;
            //Input validation
            if (typeof loan_amount !== 'number' && loan_amount <= 0)
                return reject("Invalid loan amount: " + loan_amount);
            loan_amount = toFixedDecimal(loan_amount); //decimal allowed upto 8 decimal places
            if (!(policy_id in POLICIES))
                return reject("Invalid policy: " + policy_id);
            if (!floCrypto.validateAddr(coborrower))
                return reject("Invalid coborrower id")
            //request collateral from coborrower
            floCloudAPI.sendApplicationData({
                borrower, coborrower,
                loan_amount, policy_id
            }, TYPE_LOAN_COLLATERAL_REQUEST, { receiverID: coborrower })
                .then(result => {
                    let vc = Object.keys(result)[0];
                    compactIDB.addData("outbox", result[vc], vc);
                    resolve(result);
                }).catch(error => reject(error))
        })
    }

    function validate_loanCollateral_request(loan_collateral_req_id, borrower, coborrower) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_LOAN_COLLATERAL_REQUEST, { atVectorClock: loan_collateral_req_id }).then(loan_collateral_req => {
                if (!loan_collateral_req.length)
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "request not found"));
                loan_collateral_req = loan_collateral_req[0];
                if (!floCrypto.isSameAddr(loan_collateral_req.senderID, borrower))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "sender is not borrower"));
                if (!floCrypto.isSameAddr(loan_collateral_req.receiverID, coborrower))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "receiver is not coborrower"));
                let { loan_amount, policy_id } = loan_collateral_req.message;
                if (typeof loan_amount !== 'number' && loan_amount <= 0 || VALUE_REGEX.test(loan_amount))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "Invalid loan amount"));
                if (!(policy_id in POLICIES))
                    return reject(RequestValidationError(TYPE_LOAN_COLLATERAL_REQUEST, "Invalid policy"));
                let result = { loan_amount, policy_id, borrower, coborrower };
                result.borrower_pubKey = loan_collateral_req.pubKey;
                resolve(result);
            }).catch(error => reject(error))
        })
    }

    //2. B: post loan request (with proof of collateral)
    btcMortgage.requestLoan = function (loan_collateral_req_id, borrower) {
        return new Promise((resolve, reject) => {
            const coborrower = floDapps.user.id;
            //validate request
            validate_loanCollateral_request(loan_collateral_req_id, borrower, coborrower).then(({ loan_amount, policy_id }) => {
                //calculate required collateral
                getRate["BTC"].then(rate => {
                    let policy = POLICIES[policy_id];
                    let collateral_value = calcRequiredCollateral(loan_amount * rate, policy.security_percent)
                    //check if collateral is available
                    let coborrower_floID = floCrypto.toFloID(coborrower);
                    let coborrower_btcID = btcOperator.convert.legacy2bech(coborrower_floID);
                    btcOperator.getBalance(coborrower_btcID).then(coborrower_balance => {
                        if (coborrower_balance < collateral_value)
                            return reject("Insufficient collateral available");
                        //post request
                        floCloudAPI.sendApplicationData({
                            borrower, coborrower,
                            loan_amount, policy_id, loan_collateral_req_id,
                            collateral: {
                                rate,
                                btc_id: coborrower_btcID,
                                quantity: collateral_value
                            }
                        }, TYPE_LOAN_REQUEST)
                            .then(result => {
                                let vc = Object.keys(result)[0];
                                compactIDB.addData("outbox", result[vc], vc);
                                resolve(result);
                            }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function validate_loan_request(loan_req_id, borrower, coborrower) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_LOAN_REQUEST, { atVectorClock: loan_req_id }).then(loan_req => {
                if (!loan_req.length)
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "request not found"));
                loan_req = loan_req[0];
                if (!floCrypto.isSameAddr(coborrower, loan_req.senderID))
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "request not posted by coborrower"))
                let { loan_collateral_req_id, loan_amount, policy_id, collateral } = loan_req.message;
                if (!floCrypto.isSameAddr(collateral.btc_id, coborrower))
                    return reject(RequestValidationError(TYPE_LOAN_REQUEST, "collateral btc id is not coborrower"));
                validate_loanCollateral_request(loan_collateral_req_id, borrower, coborrower).then(result => {
                    if (result.loan_amount !== loan_amount)
                        return reject(RequestValidationError(TYPE_LOAN_REQUEST, "loan amount mismatch"));
                    if (policy_id !== result.policy_id)
                        return reject(RequestValidationError(TYPE_LOAN_REQUEST, "policy id mismatch"));
                    getRate["BTC"].then(rate => {
                        if (rate * ALLOWED_DEVIATION > collateral.rate)
                            return reject(RequestValidationError(TYPE_LOAN_REQUEST, "BTC rate has reduced beyond allowed threshold"))
                        let policy = POLICIES[policy_id];
                        let required_collateral = calcRequiredCollateral(loan_amount * collateral.rate, policy.security_percent)
                        if (required_collateral > collateral.quantity)
                            return reject(RequestValidationError(TYPE_LOAN_REQUEST, "Insufficient collateral value"));
                        //check if collateral is available
                        btcOperator.getBalance(collateral.btc_id).then(coborrower_balance => {
                            if (coborrower_balance < collateral.quantity)
                                return reject(RequestValidationError(TYPE_LOAN_REQUEST, "Insufficient collateral available"));
                            result.collateral = collateral;
                            result.coborrower_pubKey = loan_req.pubKey;
                            resolve(result)
                        }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })

    }

    //3. L: respond to loan request
    btcMortgage.respondLoan = function (loan_req_id, borrower, coborrower) {
        return new Promise((resolve, reject) => {
            const lender = floDapps.user.id;
            validate_loan_request(loan_req_id, borrower, coborrower).then(({ loan_amount, borrower }) => {
                //check if loan amount (token) is available to lend
                let lender_floID = floCrypto.toFloID(lender);
                floTokenAPI.getBalance(lender_floID).then(lender_tokenBalance => {
                    if (lender_tokenBalance < loan_amount)
                        return reject("Insufficient tokens to lend");
                    floCloudAPI.sendApplicationData({
                        lender, borrower, coborrower,
                        loan_req_id
                    }, TYPE_LENDER_RESPONSE, { receiverID: borrower })
                        .then(result => {
                            let vc = Object.keys(result)[0];
                            compactIDB.addData("outbox", result[vc], vc);
                            resolve(result);
                        }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function validate_lender_response(lender_res_id, borrower, coborrower, lender) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_LENDER_RESPONSE, { atVectorClock: lender_res_id, receiverID: borrower }).then(lender_res => {
                if (!lender_res.length)
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "response not found"));
                lender_res = lender_res[0];
                if (!floCrypto.isSameAddr(lender, lender_res.senderID))
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "response not sent by lender"))
                let { loan_req_id } = lender_res.message;
                validate_loan_request(loan_req_id, borrower, coborrower).then(result => {
                    let { loan_amount } = result;
                    //check if loan amount (token) is available to lend
                    let lender_floID = floCrypto.toFloID(lender);
                    floTokenAPI.getBalance(lender_floID).then(lender_tokenBalance => {
                        if (lender_tokenBalance < loan_amount)
                            return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "lender doesnot have sufficient funds to lend"));
                        result.lender = lender;
                        result.lender_pubKey = lender_res.pubKey;
                        resolve(result);
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //4. B: requests C to lock the collateral 
    btcMortgage.requestCollateralLock = function (lender_res_id, coborrower, lender, privKey) {
        return new Promise((resolve, reject) => {
            const borrower = floDapps.user.id;
            validate_lender_response(lender_res_id, borrower, coborrower, lender).then(({ loan_amount, policy_id }) => {
                //send request to coborrower for locking the collateral asset
                let borrower_sign = sign_borrower(privKey, loan_amount, policy_id, lender);
                floCloudAPI.sendApplicationData({
                    lender, borrower, coborrower,
                    lender_res_id, borrower_sign
                }, TYPE_COLLATERAL_LOCK_REQUEST, { receiverID: collateral.provider })
                    .then(result => {
                        let vc = Object.keys(result)[0];
                        compactIDB.addData("outbox", result[vc], vc);
                        resolve(result);
                    }).catch(error => reject(error))
            }).catch(error => reject(error))
        }).catch(error => reject(error))
    }

    function validate_collateralLock_request(collateral_lock_req_id, borrower, coborrower, lender) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_COLLATERAL_LOCK_REQUEST, { atVectorClock: collateral_lock_req_id, receiverID: coborrower }).then(collateral_lock_req => {
                if (!collateral_lock_req.length)
                    return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_REQUEST, "request not found"));
                collateral_lock_req = collateral_lock_req[0];
                if (!floCrypto.isSameAddr(borrower, collateral_lock_req.senderID))
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "request not sent by borrower"));
                let { lender_res_id, borrower_sign } = collateral_lock_req.message;
                validate_lender_response(lender_res_id, borrower, coborrower, lender).then(result => {
                    let { loan_amount, policy_id } = result;
                    //verify borrower_sign
                    let borrower_sign_time = verify_borrowerSign(borrower_sign, borrower, loan_amount, policy_id, lender)
                    if (!borrower_sign_time) //MAYDO: expire signatures?
                        return reject("Invalid borrower signature");
                    result.borrower_sign = borrower_sign;
                    resolve(result);
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //5. C: locks required collateral in multisig (C, L, T)
    btcMortgage.lockCollateral = function (collateral_lock_req_id, borrower, lender, privKey) {
        return new Promise((resolve, reject) => {
            const coborrower = floDapps.user.id;
            validate_collateralLock_request(collateral_lock_req_id, borrower, coborrower, lender).then(({ borrower_sign, collateral, lender_pubKey }) => {
                //lock collateral
                lockCollateralInBlockchain(privKey, lender_pubKey, collateral.quantity).then(collateral_txid => {
                    //sign and request lender to finalize
                    let coborrower_sign = sign_coborrower(privKey, borrower_sign, collateral.rate, collateral.quantity, collateral_txid)
                    floCloudAPI.sendApplicationData({
                        borrower, coborrower, lender,
                        collateral_lock_id: collateral_txid,
                        coborrower_sign, collateral_lock_req_id
                    }, TYPE_COLLATERAL_LOCK_ACK, { receiverID: lender })
                        .then(result => {
                            let vc = Object.keys(result)[0];
                            compactIDB.addData("outbox", result[vc], vc);
                            resolve(result);
                        }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function lockCollateralInBlockchain(privKey, lenderPubKey, collateral_value) {
        return new Promise((resolve, reject) => {
            const locker_id = findLocker(floDapps.user.public, lenderPubKey).address;
            btcOperator.sendTx(floDapps.user.id, privKey, locker_id, collateral_value)
                .then(txid => resolve(txid))
                .catch(error => reject(error))
        })
    }

    function validate_collateralLock_ack(collateral_lock_ack_id, borrower, coborrower, lender) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_COLLATERAL_LOCK_ACK, { atVectorClock: collateral_lock_ack_id, receiverID: lender }).then(collateral_lock_ack => {
                if (!collateral_lock_ack.length)
                    return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_REQUEST, "request not found"));
                collateral_lock_ack = collateral_lock_ack[0];
                if (!floCrypto.isSameAddr(coborrower, collateral_lock_ack.senderID))
                    return reject(RequestValidationError(TYPE_LENDER_RESPONSE, "request not sent by coborrower"));
                let { collateral_lock_req_id, coborrower_sign, collateral_lock_id } = collateral_lock_ack.message;
                validate_collateralLock_request(collateral_lock_req_id, borrower, coborrower, lender).then(result => {
                    let { borrower_sign, collateral } = result;
                    let coborrower_sign_time = verify_coborrowerSign(coborrower_sign, coborrower, borrower_sign, collateral.rate, collateral.quantity, collateral_lock_id)
                    if (!coborrower_sign_time) //MAYDO: expire signatures?
                        return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_ACK, "Invalid coborrower signature"));
                    btcOperator.getTx(collateral_lock_id).then(collateral_tx => {
                        if (!collateral_tx.confirmations)
                            return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_ACK, "Collateral lock transaction not confirmed yet"));
                        let locker_id = findLocker(finalize_request.pubKey, lender_response.pubKey).address;
                        let locked_amt = collateral_tx.outputs.filter(o => o.address == locker_id).reduce((a, o) => a += o.value, 0);
                        if (locked_amt < collateral.quantity)
                            return reject(RequestValidationError(TYPE_COLLATERAL_LOCK_ACK, "Insufficient Collateral locked"));
                        //TODO: make sure same collateral is not reused?
                        result.coborrower_sign = coborrower_sign;
                        result.collateral_lock_id = collateral_lock_id;
                        result.collateral_time = collateral_tx.time;
                        resolve(result);
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //6. L: sends loan amount (USD tokens) to B and writes loan details in flo blockchain
    btcMortgage.sendLoanAmount = function (collateral_lock_ack_id, borrower, coborrower, privKey) {
        return new Promise((resolve, reject) => {
            const lender = floDapps.user.id;
            validate_collateralLock_ack(collateral_lock_ack_id, borrower, coborrower, lender).then(result => {
                let { loan_amount, policy_id, collateral, borrower_sign, coborrower_sign } = result;
                //transfer tokens for loan amount
                floTokenAPI.sendToken(privKey, loan_amount, borrower, "as loan", CURRENCY).then(token_txid => {
                    //construct the blockchain data
                    let lender_sign = sign_lender(privKey, coborrower_sign, token_txid);
                    let blockchainData = stringifyLoanOpenData(
                        borrower, loan_amount, policy_id, collateral.rate,
                        coborrower, collateral.quantity, collateral_lock_id,
                        lender, token_txid,
                        borrower_sign, coborrower_sign, lender_sign
                    );
                    let receivers = [borrower, coborrower].map(addr => floCrypto.toFloID(addr));
                    //write loan details in blockchain
                    floBlockchainAPI.writeDataMultiple([privKey], blockchainData, receivers)
                        .then(result => resolve(result))
                        .catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))

        })
    }

    /*Loan Closing*/

    //1. B: sends amount (PA + interest) to L (via USD tokens)
    btcMortgage.repayLoan = function (loan_id, privKey) {
        return new Promise((resolve, reject) => {
            getLoanDetails(loan_id).then(loan_details => {
                //calculate repayment amount
                let due_amount = calcDueAmount(loan_details.loan_amount, loan_details.policy_id, loan_details.open_time);
                //repay and close the loan
                let closing_sign = sign_closing(privKey, loan_id, loan_details.lender_sign);
                var closing_data = stringifyLoanCloseData(loan_id, loan_details.borrower, closing_sign);
                floTokenAPI.sendToken(privKey, due_amount, loan_details.lender, "|" + closing_data, CURRENCY).then(closing_txid => {
                    //send message to coborrower as reminder to unlock collateral
                    floCloudAPI.sendApplicationData({ loan_id, closing_txid }, TYPE_LOAN_CLOSED_ACK, { receiverID: loan_details.coborrower })
                        .then(result => {
                            let vc = Object.keys(result)[0];
                            compactIDB.addData("outbox", result[vc], vc);
                            resolve(result);
                        }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //2. C: requests L or T to free collateral
    btcMortgage.requestUnlockCollateral = function (loan_id, closing_txid, privKey) {
        return new Promise((resolve, reject) => {
            let coborrower_pubKey = floDapps.user.public;
            getLoanClosing(loan_id, closing_txid).then(loan_details => {
                //find locker
                let lender_pubKey = extractPubKeyFromSign(loan_details.lender_sign);
                let locker = findLocker(coborrower_pubKey, lender_pubKey)
                //create the tx hex and sign it
                createUnlockCollateralTxHex(locker, loan_details.collateral_lock_id, privKey).then(unlock_tx_hex => {
                    floCloudAPI.sendApplicationData({
                        loan_id, closing_txid, unlock_tx_hex
                    }, TYPE_UNLOCK_COLLATERAL_REQUEST, { receiverID: loan_details.lender })
                        .then(result => {
                            let vc = Object.keys(result)[0];
                            compactIDB.addData("outbox", result[vc], vc);
                            resolve(result);
                        }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function createUnlockCollateralTxHex(locker, collateral_lock_id, privKey) {
        return new Promise((resolve, reject) => {
            btcOperator.getUTXOs(locker.address).then(utxos => {
                let collateral_utxos = utxos.filter(u => u.txid == collateral_lock_id);
                if (!collateral_utxos.length)
                    return reject("Collateral already unlocked");
                btcOperator.getTx(collateral_lock_id).then(collateral_tx => {
                    if (collateral_tx.confirmations == 0)
                        return reject("Collateral not confirmed in blockchain"); //This should not happen, as loan will not be issued until collateral is locked with confirmations
                    let collateral_owner = collateral_tx.inputs[0].address; //this will be coborrower's BTC id
                    //create the tx
                    const tx = coinjs.transaction();
                    //estimate the fee
                    let estimate_tx_size = BASE_TX_SIZE;
                    estimate_tx_size += collateral_utxos.length * btcOperator.util.sizePerInput(locker.address, locker.redeemScript)
                    estimate_tx_size += btcOperator.util.sizePerOutput(collateral_owner);
                    btcOperator.util.get_fee_rate().then(fee_rate => {
                        let fee_estimate = fee_rate * estimate_tx_size;
                        //add inputs
                        let total_input_value = 0;
                        collateral_utxos.forEach(u => {
                            //locker is btc bech32 multisig
                            let s = coinjs.script();
                            s.writeBytes(Crypto.util.hexToBytes(rs));
                            s.writeOp(0);
                            s.writeBytes(coinjs.numToBytes(u.value.toFixed(0), 8));
                            script = Crypto.util.bytesToHex(s.buffer);
                            tx.addinput(u.txid, u.vout, script, 0xfffffffd /*sequence*/); //0xfffffffd for Replace-by-fee
                            total_input_value += u.value;
                        });
                        total_input_value = btcOperator.util.Sat_to_BTC(total_input_value); //convert from satoshi to BTC
                        //add output
                        let receiver_amount = total_input_value - fee_estimate;
                        console.debug("FEE calc", total_input_value, fee_estimate, receiver_amount);
                        tx.addoutput(collateral_owner, receiver_amount);
                        tx.sign(privKey, 1 /*sighashtype*/);
                        resolve(tx.serialize())
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //3. L: unlock collateral
    btcMortgage.unlockCollateral = function (loan_id, closing_txid, unlock_tx_hex, privKey) {
        let lender_pubKey = floDapps.user.public;
        getLoanClosing(loan_id, closing_txid).then(loan_details => {
            //find locker
            let coborrower_pubKey = extractPubKeyFromSign(loan_details.coborrower_sign);
            let locker = findLocker(coborrower_pubKey, lender_pubKey)
            //verify and sign the tx
            signUnlockCollateralTxHex(locker, loan_details.collateral_lock_id, unlock_tx_hex, privKey).then(signed_tx_hex => {
                btcOperator.broadcastTx(signed_tx_hex).then(txid => {
                    floCloudAPI.sendApplicationData({
                        loan_id, closing_txid, unlock_collateral_id: txid
                    }, TYPE_UNLOCK_COLLATERAL_ACK, { receiverID: loan_details.coborrower })
                        .then(result => {
                            let vc = Object.keys(result)[0];
                            compactIDB.addData("outbox", result[vc], vc);
                            resolve(result);
                        }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        }).catch(error => reject(error))
    }

    function signUnlockCollateralTxHex(locker, collateral_lock_id, unlock_tx_hex, privKey) {
        return new Promise((resolve, reject) => {
            btcOperator.getUTXOs(locker.address).then(utxos => {
                let collateral_utxos = utxos.filter(u => u.txid == collateral_lock_id);
                if (!collateral_utxos.length)
                    return reject("Collateral already unlocked");
                btcOperator.getTx(collateral_lock_id).then(collateral_tx => {
                    if (collateral_tx.confirmations == 0)
                        return reject("Collateral not confirmed in blockchain"); //This should not happen, as loan will not be issued until collateral is locked with confirmations
                    //create the tx
                    let tx = coinjs.transaction().deserialize(unlock_tx_hex);
                    //check inputs
                    if (tx.ins.some(i => i.outpoint.hash !== collateral_lock_id))//vin other than this collateral is present in tx, ABORT
                        return reject("Transaction Hex contains other/non collateral inputs");
                    //sign the tx hex
                    tx.sign(privKey, 1 /*sighashtype*/);
                    resolve(tx.serialize())
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    //Banker involvement when one party fails

    btcMortgage.banker = {};
    btcMortgage.requestBanker = {};

    // C: request T (banker) for collateral refund when lender hasnt dispersed the loan for 24 hrs
    btcMortgage.requestBanker.refundCollateral = function (collateral_lock_ack_id, borrower, lender, privKey) {
        return new Promise((resolve, reject) => {
            const coborrower = floDapps.user.id;
            let coborrower_pubKey = floDapps.user.public;
            validate_collateralLock_ack(collateral_lock_ack_id, borrower, coborrower, lender).then(result => {
                let { lender_pubKey, collateral_lock_id } = result;
                let locker = findLocker(coborrower_pubKey, lender_pubKey)
                //create the tx hex and sign it
                createUnlockCollateralTxHex(locker, collateral_lock_id, privKey).then(unlock_tx_hex => {
                    floCloudAPI.sendApplicationData({
                        borrower, coborrower, lender,
                        collateral_lock_ack_id, unlock_tx_hex
                    }, TYPE_REFUND_COLLATERAL_REQUEST)
                        .then(result => {
                            let vc = Object.keys(result)[0];
                            compactIDB.addData("outbox", result[vc], vc);
                            resolve(result);
                        }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    // T: verify and refund collateral
    btcMortgage.banker.refundCollateral = function (collateral_refund_req_id, borrower, coborrower, lender, privKey) {
        return new Promise((resolve, reject) => {
            //validate request
            validate_collateralRefund_request(collateral_refund_req_id, borrower, coborrower, lender).then(result => {
                let { unlock_tx_hex, collateral_lock_id, coborrower_pubKey, lender_pubKey } = result;
                let locker = findLocker(coborrower_pubKey, lender_pubKey)
                //verify and sign the tx
                signUnlockCollateralTxHex(locker, collateral_lock_id, unlock_tx_hex, privKey).then(signed_tx_hex => {
                    btcOperator.broadcastTx(signed_tx_hex).then(txid => {
                        floCloudAPI.sendApplicationData({
                            collateral_refund_req_id, refund_collateral_id: txid
                        }, TYPE_REFUND_COLLATERAL_ACK, { receiverID: coborrower })
                            .then(result => {
                                let vc = Object.keys(result)[0];
                                compactIDB.addData("outbox", result[vc], vc);
                                resolve(result);
                            }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function validate_collateralRefund_request(collateral_refund_req_id, borrower, coborrower, lender) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_REFUND_COLLATERAL_REQUEST, { atVectorClock: collateral_refund_req_id }).then(collateral_refund_req => {
                if (!collateral_refund_req.length)
                    return reject(RequestValidationError(TYPE_REFUND_COLLATERAL_REQUEST, "request not found"));
                collateral_refund_req = collateral_refund_req[0];
                if (!floCrypto.isSameAddr(coborrower, collateral_refund_req.senderID))
                    return reject(RequestValidationError(TYPE_REFUND_COLLATERAL_REQUEST, "request not sent by coborrower"));
                let { collateral_lock_ack_id, unlock_tx_hex } = collateral_refund_req.message;
                validate_collateralLock_ack(collateral_lock_ack_id, borrower, coborrower, lender).then(result => {
                    let { collateral_time } = result;
                    let current_time = Date.now();
                    if (current_time - WAIT_TIME > collateral_time)
                        return reject(RequestValidationError(TYPE_REFUND_COLLATERAL_REQUEST, "Still in waiting period"));
                    result.unlock_tx_hex = unlock_tx_hex;
                    resolve(result);
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    // L: request T (banker) to liquidate collateral due to failure of repayment by borrower
    btcMortgage.requestBanker.liquateCollateral = function (loan_id, privKey) {
        return new Promise((resolve, reject) => {
            let lender_pubKey = floDapps.user.public;
            getLoanDetails(loan_id).then(loan_details => {
                //calculate due amount
                let due_amount = calcDueAmount(loan_details.loan_amount, loan_details.policy_id, loan_details.open_time)
                //create tx hex for liquidation and send to banker
                let coborrower_pubKey = extractPubKeyFromSign(loan_details.coborrower_sign);
                createLiquidateCollateralTxHex(coborrower_pubKey, lender_pubKey, loan_details.collateral_lock_id, due_amount, privKey).then(txHex => {
                    floCloudAPI.sendApplicationData({
                        loan_id, liquidate_tx_hex: txHex
                    }, TYPE_LIQUATE_COLLATERAL_REQUEST)
                        .then(result => {
                            let vc = Object.keys(result)[0];
                            compactIDB.addData("outbox", result[vc], vc);
                            resolve(result);
                        }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    btcMortgage.banker.liquateCollateral = function (collateral_liquate_req_id, privKey) {
        return new Promise((resolve, reject) => {
            validate_liquateCollateral_request(collateral_liquate_req_id).then(result => {
                let { loan_details, liquidate_tx_hex } = result;
                //calculate due amount
                let due_amount = calcDueAmount(loan_details.loan_amount, loan_details.policy_id, loan_details.open_time)
                //sign 
                let coborrower_pubKey = extractPubKeyFromSign(loan_details.coborrower_sign);
                let lender_pubKey = extractPubKeyFromSign(loan_details.lender_sign);
                getRate["BTC"].then(rate => {
                    due_amount = toFixedDecimal(due_amount / rate); //USD to BTC
                    signLiquidateCollateralTxHex(coborrower_pubKey, lender_pubKey, loan_details.collateral_lock_id, liquidate_tx_hex, due_amount, privKey).then(txHex => {
                        floCloudAPI.sendApplicationData({
                            loan_id, liquidate_tx_hex: txHex
                        }, TYPE_LIQUATE_COLLATERAL_ACK)
                            .then(result => {
                                let vc = Object.keys(result)[0];
                                compactIDB.addData("outbox", result[vc], vc);
                                resolve(result);
                            }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function validate_liquateCollateral_request(collateral_liquate_req_id) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_LIQUATE_COLLATERAL_REQUEST, { atVectorClock: collateral_liquate_req_id }).then(collateral_liquate_req => {
                if (!collateral_liquate_req.length)
                    return reject(RequestValidationError(TYPE_LIQUATE_COLLATERAL_REQUEST, "request not found"));
                collateral_liquate_req = collateral_liquate_req[0];
                let { loan_id, liquidate_tx_hex } = collateral_liquate_req.message;
                getLoanDetails(loan_id).then(loan_details => {
                    if (!floCrypto.isSameAddr(loan_details.lender, collateral_liquate_req.senderID))
                        return reject(RequestValidationError(TYPE_LIQUATE_COLLATERAL_REQUEST, "request not sent by lender"));
                    checkIfLoanClosed(loan, loan_details.borrower, loan_details.lender).then(close_id => {
                        if (close_id) //close loan data found
                            return reject(RequestValidationError(TYPE_LIQUATE_COLLATERAL_REQUEST, "Loan already closed"));
                        else resolve({ loan_details, liquidate_tx_hex });
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    // L: request T (banker) to preliquidate collateral when collateral value has dropped to risk threshold
    btcMortgage.requestBanker.preliquateCollateral = function (loan_id, privKey) {
        return new Promise((resolve, reject) => {
            let lender_pubKey = floDapps.user.public;
            getLoanDetails(loan_id).then(loan_details => {
                let policy = POLICIES[loan_details.policy_id];
                if (isNaN(policy.pre_liquidation_threshold))
                    return reject("This loan policy doesnot allow pre-liquidation");
                getRate["USD"].then(cur_btc_rate => {
                    if (cur_btc_rate >= loan_details.btc_start_rate)
                        return reject("BTC rate hasn't reduced from the start rate");
                    let drop_percent = calcRateDropPercent(cur_btc_rate, loan_details.btc_start_rate)
                    if (drop_percent < policy.pre_liquidation_threshold)
                        return reject("BTC rate hasn't dropped beyond threshold");
                    //calculate due amount
                    let due_amount = calcDueAmount(loan_details.loan_amount, loan_details.policy_id, loan_details.open_time)
                    //create tx hex for liquidation and send to banker
                    let coborrower_pubKey = extractPubKeyFromSign(loan_details.coborrower_sign);
                    createLiquidateCollateralTxHex(coborrower_pubKey, lender_pubKey, loan_details.collateral_lock_id, due_amount, privKey).then(txHex => {
                        floCloudAPI.sendApplicationData({
                            loan_id, liquidate_tx_hex: txHex
                        }, TYPE_PRELIQUATE_COLLATERAL_REQUEST)
                            .then(result => {
                                let vc = Object.keys(result)[0];
                                compactIDB.addData("outbox", result[vc], vc);
                                resolve(result);
                            }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    btcMortgage.banker.preliquateCollateral = function (collateral_preliquate_req_id, privKey) {
        return new Promise((resolve, reject) => {
            validate_preliquateCollateral_request(collateral_preliquate_req_id).then(result => {
                let { loan_details, liquidate_tx_hex } = result;
                //calculate due amount
                let due_amount = calcDueAmount(loan_details.loan_amount, loan_details.policy_id, loan_details.open_time)
                //sign 
                let coborrower_pubKey = extractPubKeyFromSign(loan_details.coborrower_sign);
                let lender_pubKey = extractPubKeyFromSign(loan_details.lender_sign);
                getRate["BTC"].then(rate => {
                    due_amount = toFixedDecimal(due_amount / rate); //USD to BTC
                    signLiquidateCollateralTxHex(coborrower_pubKey, lender_pubKey, loan_details.collateral_lock_id, liquidate_tx_hex, due_amount, privKey).then(txHex => {
                        floCloudAPI.sendApplicationData({
                            loan_id, liquidate_tx_hex: txHex
                        }, TYPE_PRELIQUATE_COLLATERAL_ACK)
                            .then(result => {
                                let vc = Object.keys(result)[0];
                                compactIDB.addData("outbox", result[vc], vc);
                                resolve(result);
                            }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function validate_preliquateCollateral_request(collateral_preliquate_req_id) {
        return new Promise((resolve, reject) => {
            floCloudAPI.requestApplicationData(TYPE_PRELIQUATE_COLLATERAL_REQUEST, { atVectorClock: collateral_preliquate_req_id }).then(collateral_preliquate_req => {
                if (!collateral_preliquate_req.length)
                    return reject(RequestValidationError(TYPE_PRELIQUATE_COLLATERAL_REQUEST, "request not found"));
                collateral_preliquate_req = collateral_preliquate_req[0];
                let { loan_id, liquidate_tx_hex } = collateral_preliquate_req.message;
                getLoanDetails(loan_id).then(loan_details => {
                    if (!floCrypto.isSameAddr(loan_details.lender, collateral_preliquate_req.senderID))
                        return reject(RequestValidationError(TYPE_PRELIQUATE_COLLATERAL_REQUEST, "request not sent by lender"));
                    checkIfLoanClosed(loan, loan_details.borrower, loan_details.lender).then(close_id => {
                        if (close_id) //close loan data found
                            return reject(RequestValidationError(TYPE_PRELIQUATE_COLLATERAL_REQUEST, "Loan already closed"));
                        let policy = POLICIES[loan_details.policy_id];
                        if (isNaN(policy.pre_liquidation_threshold))
                            return reject("This loan policy doesnot allow pre-liquidation");
                        getRate["USD"].then(cur_btc_rate => {
                            if (cur_btc_rate >= loan_details.btc_start_rate)
                                return reject(RequestValidationError(TYPE_PRELIQUATE_COLLATERAL_REQUEST, "BTC rate hasn't reduced from the start rate"));
                            let drop_percent = calcRateDropPercent(cur_btc_rate, loan_details.btc_start_rate)
                            if (drop_percent < policy.pre_liquidation_threshold)
                                return reject(RequestValidationError(TYPE_PRELIQUATE_COLLATERAL_REQUEST, "BTC rate hasn't dropped beyond threshold"));
                            resolve({ loan_details, liquidate_tx_hex });
                        }).catch(error => reject(error))
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function createLiquidateCollateralTxHex(coborrower_pubKey, lender_pubKey, collateral_lock_id, due_amount, privKey) {
        return new Promise((resolve, reject) => {
            //find locker, pubkeys and ids
            let locker = findLocker(coborrower_pubKey, lender_pubKey),
                coborrower_btcID = btcOperator.bech32Address(coborrower_pubKey),
                lender_btcID = btcOperator.bech32Address(lender_pubKey);
            //get collateral utxos
            btcOperator.getUTXOs(locker.address).then(utxos => {
                let collateral_utxos = utxos.filter(u => u.txid == collateral_lock_id);
                if (!collateral_utxos.length)
                    return reject("Collateral already unlocked");
                btcOperator.getTx(collateral_lock_id).then(collateral_tx => {
                    if (collateral_tx.confirmations == 0)
                        return reject("Collateral not confirmed in blockchain"); //This should not happen, as loan will not be issued until collateral is locked with confirmations
                    let collateral_owner = collateral_tx.inputs[0].address; //this will be coborrower's BTC id
                    if (!floCrypto.isSameAddr(collateral_owner, coborrower_btcID))
                        return reject("Collateral owner isnt coborrower"); //this should not happen
                    //create the tx
                    const tx = coinjs.transaction();
                    //estimate the fee
                    let estimate_tx_size = BASE_TX_SIZE;
                    estimate_tx_size += collateral_utxos.length * btcOperator.util.sizePerInput(locker.address, locker.redeemScript)
                    estimate_tx_size += btcOperator.util.sizePerOutput(collateral_owner) + btcOperator.util.sizePerOutput(lender_btcID);
                    btcOperator.util.get_fee_rate().then(fee_rate => {
                        let fee_estimate = fee_rate * estimate_tx_size;
                        //add inputs
                        let total_input_value = 0;
                        collateral_utxos.forEach(u => {
                            //locker is btc bech32 multisig
                            let s = coinjs.script();
                            s.writeBytes(Crypto.util.hexToBytes(rs));
                            s.writeOp(0);
                            s.writeBytes(coinjs.numToBytes(u.value.toFixed(0), 8));
                            script = Crypto.util.bytesToHex(s.buffer);
                            tx.addinput(u.txid, u.vout, script, 0xfffffffd /*sequence*/); //0xfffffffd for Replace-by-fee
                            total_input_value += u.value;
                        });
                        total_input_value = btcOperator.util.Sat_to_BTC(total_input_value); //convert from satoshi to BTC
                        //add output
                        let liquidate_amount = due_amount / fee_rate; //convert due amount to equivalent BTC amount
                        tx.addoutput(lender_btcID, liquidate_amount - fee_estimate);
                        console.debug("LIQUIDATE", total_input_value, liquidate_amount, fee_estimate)
                        if (liquidate_amount < total_input_value) { //return remaining of collateral to collateral owner(coborrower)
                            let return_amount = total_input_value - liquidate_amount;
                            tx.addoutput(collateral_owner, return_amount);
                        }
                        tx.sign(privKey, 1 /*sighashtype*/);
                        resolve(tx.serialize())
                    }).catch(error => reject(error))
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function signLiquidateCollateralTxHex(coborrower_pubKey, lender_pubKey, collateral_lock_id, unlock_tx_hex, due_amount, privKey) {
        return new Promise((resolve, reject) => {
            //find locker, pubkeys and ids
            let locker = findLocker(coborrower_pubKey, lender_pubKey),
                coborrower_btcID = btcOperator.bech32Address(coborrower_pubKey),
                lender_btcID = btcOperator.bech32Address(lender_pubKey);
            btcOperator.getUTXOs(locker.address).then(utxos => {
                let collateral_utxos = utxos.filter(u => u.txid == collateral_lock_id);
                if (!collateral_utxos.length)
                    return reject("Collateral already unlocked");
                let total_collateral_value = collateral_utxos.reduce((a, o) => a += o.value, 0);
                total_collateral_value = btcOperator.util.Sat_to_BTC(total_collateral_value);
                btcOperator.getTx(collateral_lock_id).then(collateral_tx => {
                    if (collateral_tx.confirmations == 0)
                        return reject("Collateral not confirmed in blockchain"); //This should not happen, as loan will not be issued until collateral is locked with confirmations
                    //create the tx
                    let tx = coinjs.transaction().deserialize(unlock_tx_hex);
                    //check inputs
                    if (tx.ins.some(i => i.outpoint.hash !== collateral_lock_id))//vin other than this collateral is present in tx, ABORT
                        return reject("Transaction Hex contains other/non collateral inputs");
                    if (tx.ins.length != collateral_utxos.length)
                        return reject("Transaction hex doesnot contain full collateral as input")
                    //check output
                    let return_amount = total_collateral_value - due_amount;
                    if (return_amount > 0) {
                        let return_outpts_amount = tx.outs.filter(o => spendScriptToAddress(o.script) == coborrower_btcID).reduce((a, o) => a += o.value, 0)
                        return_outpts_amount = btcOperator.util.Sat_to_BTC(return_outpts_amount);
                        if (return_outpts_amount < return_amount)
                            return reject("Return value after liquidation is lower")
                    }
                    //sign the tx hex
                    tx.sign(privKey, 1 /*sighashtype*/);
                    resolve(tx.serialize())
                }).catch(error => reject(error))
            }).catch(error => reject(error))
        })
    }

    function spendScriptToAddress(script) {
        var address;
        switch (script.chunks[0]) {
            case 0: //bech32, multisig-bech32
                address = btcOperator.util.encodeBech32(Crypto.util.bytesToHex(script.chunks[1]), coinjs.bech32.version, coinjs.bech32.hrp);
                break;
            case 169: //segwit, multisig-segwit
                address = btcOperator.util.encodeLegacy(Crypto.util.bytesToHex(script.chunks[1]), coinjs.multisig);
                break;
            case 118: //legacy
                address = btcOperator.util.encodeLegacy(Crypto.util.bytesToHex(script.chunks[2]), coinjs.pub);
        }
        return address;
    }

    function checkIfLoanClosed(loan_id, borrower, lender) {
        return new Promise((resolve, reject) => {
            var query_options = { sentOnly: true, tx: true, receivers: [floCrypto.toFloID(lender)] };
            let filter = d => {
                if (!d.startsWith(LOAN_CLOSING_IDENTIFIER))
                    return false;
                let closing_details = parseLoanCloseData(d);
                return closing_details.loan_id === loan_id;
            }
            floBlockchainAPI.getLatestData(borrower, filter, query_options).then(result => {
                if (result.item) {
                    let close_id = result.item.txid
                    getLoanClosing(loan_id, close_id).then(loan_details => {
                        //loan already close, reject this request for preliquidate
                        resolve(loan_details)
                    }).catch(error => reject(error))
                }
                else resolve(false);
            }).catch(error => reject(error))
        })
    }

})(window.btcMortgage = {})